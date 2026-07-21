// agent.rs — run an external agentic coding CLI as a subprocess and forward its raw stdout lines
// to the webview over a Tauri channel (a "dumb pipe"). All decoding of the CLI's stream-json /
// JSONL into the AI SDK UIMessageChunk model happens in TS (features/run-agent/lib/transform.ts).
// Non-native model picks route the CLI through the per-run local gateway (see gateway.rs) so the
// real provider key never enters the CLI process.
// Mirrors the LLM streaming path (see stream.rs / compat.rs): one command, events over a Channel,
// cancellation via the shared cancel registry.
use crate::harness::{Arg, EnvSpec, HarnessSpec, PromptChannel};
use crate::stream::cancel_guard;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// Live stdin handles for runs holding a stdio protocol (warm harnesses), keyed by stream id.
// `agent_respond` writes permission answers into them (claude control_responses / codex JSON-RPC
// approval results) while the pump loop reads stdout. tokio Mutex on the handle: writes are async; the outer std Mutex only
// guards map access (never held across await).
pub(crate) type StdinHandle = Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>;

pub(crate) fn agent_stdins() -> &'static Mutex<HashMap<String, StdinHandle>> {
    static R: OnceLock<Mutex<HashMap<String, StdinHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

// Warm-session key per live stream — lets agent_respond find the AgentSession behind an answer
// (a plan-approve control_response carries updatedPermissions setMode: the CLI switches its own
// mode, and the session's tracked mode must follow or a later reconcile no-ops against reality).
pub(crate) fn agent_session_keys() -> &'static Mutex<HashMap<String, String>> {
    static R: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

// RAII: drop the stdin handle on every agent_run exit path. Removing the map entry drops the
// last Arc (agent_respond only holds a transient clone), which closes the pipe — the CLI sees
// stdin EOF and exits instead of waiting for more stream-json input.
struct StdinGuard {
    id: String,
}

impl Drop for StdinGuard {
    fn drop(&mut self) {
        agent_stdins().lock().unwrap().remove(&self.id);
        agent_session_keys().lock().unwrap().remove(&self.id);
    }
}

// The mode a control_response switches the CLI to, if any: updatedPermissions carrying a
// {type:"setMode", mode} entry (plan approval rides "acceptEdits" this way).
fn set_mode_of(v: &serde_json::Value) -> Option<String> {
    if v.get("type")?.as_str()? != "control_response" {
        return None;
    }
    let perms = v.get("response")?.get("response")?.get("updatedPermissions")?.as_array()?;
    perms.iter().find_map(|p| {
        if p.get("type")?.as_str()? != "setMode" {
            return None;
        }
        Some(p.get("mode")?.as_str()?.to_string())
    })
}

// Answer a pending control_request (e.g. a can_use_tool permission prompt) by writing one JSON
// line to the live run's stdin. The payload is validated as JSON so a malformed string can't
// corrupt the stream-json channel.
#[tauri::command]
pub async fn agent_respond(stream_id: String, payload: String) -> Result<(), String> {
    let parsed = serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|e| format!("payload must be JSON: {}", e))?;
    let handle = agent_stdins()
        .lock()
        .unwrap()
        .get(&stream_id)
        .cloned()
        .ok_or_else(|| "no live agent run for this stream".to_string())?;
    {
        let mut stdin = handle.lock().await;
        let write = async {
            stdin.write_all(payload.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        write
            .await
            .map_err(|e: std::io::Error| format!("failed to write control response: {}", e))?;
    }
    // Mirror a setMode answer into the warm session's tracked mode, so the next turn's
    // reconcile_permission_mode compares against what the CLI actually runs under.
    if let Some(mode) = set_mode_of(&parsed) {
        let key = agent_session_keys().lock().unwrap().get(&stream_id).cloned();
        if let Some(session) = key.and_then(|k| crate::session::get(&k)) {
            session.note_permission_mode(&mode);
        }
    }
    Ok(())
}

// Events sent back to the webview. `Line` carries one raw stdout line from the CLI (decoded in TS);
// `Error` is a spawn/exit failure; `Stderr` is one live stderr line from a warm run (retry/backoff
// notices the webview shows as transient turn status — otherwise invisible until process death);
// `Done` marks the turn's end.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum PipeEvent {
    Line(String),
    Error(String),
    Stderr(String),
    Done,
}

// Where a routed run should ultimately land: the target endpoint's protocol + base + real key.
// The gateway sits between the CLI and this target; the key never reaches the CLI itself.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteTarget {
    pub protocol: String, // "anthropic" | "openai"
    pub base_url: String,
    pub api_key: String,
}

// One image attached to a turn: a MIME type + base64 payload (no data-URL prefix). Per-turn
// content, like the prompt — it rides begin_turn, never the warm-session fingerprint. Each harness
// wraps it in its own native content block (claude_user_line here; codex/kimi_proto builders).
#[derive(serde::Deserialize, Clone)]
pub(crate) struct ImageInput {
    pub mime: String,
    pub data: String,
}

// The claude stream-json user line: a text block plus one native Anthropic image block per
// attachment. Shared by the cold per-turn path and the warm session (session.rs begin_turn) so the
// two can't drift.
pub(crate) fn claude_user_line(prompt: &str, images: &[ImageInput]) -> String {
    let mut content = Vec::new();
    // Drop an empty text block when an image carries the turn (Anthropic rejects empty text
    // blocks); keep it when there are no images so the content array is never empty.
    if !prompt.is_empty() || images.is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": prompt }));
    }
    for im in images {
        content.push(serde_json::json!({
            "type": "image",
            "source": { "type": "base64", "media_type": im.mime, "data": im.data }
        }));
    }
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    })
    .to_string()
}

// Build argv from the harness's declarative template. The prompt never enters argv — it rides
// the harness's PromptChannel. `gateway_url` (Some on a routed run) fills the {url} slot in
// Arg::RouteArgs; the gateway token is never placed in argv (env-only). `resume` (a session id
// captured from a prior run) fills the {id} slot in Arg::Resume.
fn build_argv(
    spec: &HarnessSpec,
    model: &str,
    permission_mode: &str,
    effort: &str,
    gateway_url: Option<&str>,
    resume: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for a in spec.argv {
        match a {
            Arg::Lit(s) => args.push((*s).to_string()),
            Arg::ModelFlag(flag) => {
                if !model.is_empty() {
                    args.push((*flag).to_string());
                    args.push(model.to_string());
                }
            }
            Arg::EffortFlag(flag) => {
                if !effort.is_empty() {
                    args.push((*flag).to_string());
                    args.push(effort.to_string());
                }
            }
            Arg::Permission(map) => args.extend(map(permission_mode)),
            Arg::RouteArgs => {
                if let Some(url) = gateway_url {
                    for r in spec.env.route_args {
                        args.push(r.replace("{url}", url).replace("{model}", model));
                    }
                }
            }
            Arg::Resume => {
                if let Some(id) = resume.filter(|id| !id.is_empty()) {
                    for r in spec.resume_args {
                        args.push(r.replace("{id}", id));
                    }
                }
            }
        }
    }
    args
}

// Spawn the harness CLI. The executable is pre-resolved (managed agents prefix or system PATH —
// see installer::resolve_bin) and invoked directly. Invoking directly — instead
// of routing through `cmd /C` — leaves Rust std as the only layer that escapes arguments; std safely
// quotes args for batch files and refuses ones it can't (BatBadBut / CVE-2024-24576), so a crafted
// prompt cannot break out into a shell command.
// `routed` re-points the CLI at the local gateway per the harness's EnvSpec: (gateway url, gateway
// token, model). Env-only — the token must never reach argv (visible in process listings), logs,
// or any AgentEvent string.
// `path_env` (managed Node runtime present) puts the portable node ahead of the system one so the
// CLI's `node` shim never picks a broken system install.
fn spawn(
    program: &std::path::Path,
    args: &[String],
    cwd: &str,
    routed: Option<(&EnvSpec, &str, &str, &str)>,
    codex_home: Option<&std::path::Path>,
    claude_token: Option<&str>,
    path_env: Option<&std::ffi::OsStr>,
    stdin_piped: bool,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin_piped { Stdio::piped() } else { Stdio::null() })
        // Backstop: if a Child is ever dropped while running (warm session evicted from the
        // registry mid-race, per-turn reap timeout), the OS process dies with it.
        .kill_on_drop(true);
    if let Some((env, gateway_url, token, model)) = routed {
        for k in env.base_url {
            cmd.env(k, gateway_url);
        }
        for k in env.api_key {
            cmd.env(k, token);
        }
        for k in env.model_pins {
            cmd.env(k, model);
        }
        for k in env.remove {
            cmd.env_remove(k);
        }
    }
    if let Some(home) = codex_home {
        cmd.env("CODEX_HOME", home);
    }
    // Claude OAuth from the app's Providers login (same public client as `claude setup-token`).
    // Env-only, never argv; drop any inherited API key so it can't shadow the account token.
    if let Some(tok) = claude_token {
        cmd.env("CLAUDE_CODE_OAUTH_TOKEN", tok);
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    cmd.spawn()
}

// npm-shipped CLIs are Node programs. If the system Node is missing or broken, silently
// provision the app's portable runtime (one-time download) so the CLI's `node` shim never
// picks a bad install. A managed native binary needs no Node at all — skip the probe.
async fn ensure_node_for(
    app: &tauri::AppHandle,
    spec: &HarnessSpec,
    program: &std::path::Path,
) -> Result<(), String> {
    if matches!(spec.install, crate::harness::Install::Npm(_))
        && !crate::installer::is_native_install(app, program)
        && !crate::node_runtime::system_node_acceptable()
    {
        crate::node_runtime::ensure(app).await?;
    }
    Ok(())
}

// Start a session gateway for a routed run: returns the gateway + its loopback origin, or
// (None, None) for a native-login run. `target` = (protocol, base_url, api_key). `effort` is the
// level picked in the app ("" = Auto) — the translation needs it because the CLI's own request
// always carries a default effort and so can't express the user's choice.
async fn start_gateway_for(
    spec: &HarnessSpec,
    target: Option<(&str, &str, &str)>,
    effort: &str,
) -> Result<(Option<crate::gateway::Gateway>, Option<String>), String> {
    let Some((protocol, base_url, api_key)) = target else { return Ok((None, None)) };
    let outbound = match protocol {
        "anthropic" => crate::gateway::Proto::Anthropic,
        "openai" => crate::gateway::Proto::OpenAi,
        other => return Err(format!("unknown target protocol: {}", other)),
    };
    let gw = crate::gateway::start(crate::gateway::GatewayConfig {
        inbound: spec.protocol,
        outbound,
        target_base: base_url.to_string(),
        api_key: api_key.to_string(),
        effort: effort.to_string(),
    })
    .await
    .map_err(|e| format!("failed to start gateway: {}", e))?;
    let url = format!("http://127.0.0.1:{}", gw.port);
    Ok((Some(gw), Some(url)))
}

// RAII for agent_run's per-turn gateway: shuts it down on every exit path (including panics),
// mirroring StdinGuard. Warm sessions instead carry their gateway inside AgentSession.
struct GatewayGuard(Option<crate::gateway::Gateway>);

impl Drop for GatewayGuard {
    fn drop(&mut self) {
        if let Some(g) = &self.0 {
            g.shutdown();
        }
    }
}

// ChatGPT (Codex) OAuth tokens forwarded from the app's Providers login, used to run the codex
// CLI on the account connected in Modelius instead of requiring a separate `codex login`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuth {
    id_token: String,
    access_token: String,
    refresh_token: Option<String>,
    account_id: String,
}

// Materialize an isolated CODEX_HOME with an auth.json the codex CLI understands (same plaintext
// shape the CLI itself writes to ~/.codex/auth.json — parity, not a new exposure). Isolated dir so
// we never clobber a user's own `codex login` state; rewritten fresh before every run.
fn write_codex_home(app: &tauri::AppHandle, auth: &CodexAuth) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", e))?
        .join("codex-home");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create codex home: {}", e))?;
    let body = serde_json::json!({
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": auth.id_token,
            "access_token": auth.access_token,
            "refresh_token": auth.refresh_token.as_deref().unwrap_or(""),
            "account_id": auth.account_id,
        },
        "last_refresh": humantime::format_rfc3339(std::time::SystemTime::now()).to_string(),
    });
    // Owner-only on Unix (mode set at create, never briefly world-readable) — same 0600 the codex
    // CLI uses for its own auth.json. On Windows the per-user app-data ACL already scopes access.
    let path = dir.join("auth.json");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("failed to secure codex home: {}", e))?;
        opts.mode(0o600);
    }
    use std::io::Write;
    let mut f = opts.open(&path).map_err(|e| format!("failed to write codex auth: {}", e))?;
    f.write_all(body.to_string().as_bytes())
        .map_err(|e| format!("failed to write codex auth: {}", e))?;
    Ok(dir)
}

// List the Codex models the connected ChatGPT account can actually run, by asking `codex
// app-server`'s model/list — the same subscription-filtered set the CLI's `/model` shows (so a
// free/Plus account never sees a Pro-only model like gpt-5.6-sol). A THROWAWAY app-server: spawn,
// handshake, one request, kill. Kept off the warm session registry (session.rs) because the warm
// pump only tracks thread/turn ids and discards other response bodies. Returns the raw
// `{data:[…]}` result; the webview maps it to picker entries + effort tiers (codexModels.ts).
// Shared model-discovery probe: spawn a THROWAWAY CLI process on its stdio protocol (native run,
// no gateway/model/effort/resume — argv from build_argv), write the pipelined handshake lines
// (probe-verified spawn_warm pattern), and return the result of the response with `want_id`.
// Server-request lines (carrying "method") never end the probe. Bounded by a 15s timeout so a
// hung process can't wedge the command. `probe` names the awaited request in error messages.
async fn probe_app_server(
    app: &tauri::AppHandle,
    spec: &'static HarnessSpec,
    cwd: &str,
    codex_home: Option<&std::path::Path>,
    handshake: Vec<String>,
    want_id: u64,
    probe: &str,
) -> Result<serde_json::Value, String> {
    let program = crate::installer::resolve_bin(app, spec.bin)
        .ok_or_else(|| format!("'{}' not found — install it from the Environment picker.", spec.bin))?;
    ensure_node_for(app, spec, &program).await?;
    let path_env = crate::node_runtime::child_path_env(app);
    let args = build_argv(spec, "", "", "", None, None);
    let argv0 = args.first().cloned().unwrap_or_default();
    let mut child = spawn(&program, &args, cwd, None, codex_home, None, path_env.as_deref(), true)
        .map_err(|e| format!("failed to start '{}' {}: {}", spec.bin, argv0, e))?;

    let mut stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;

    let write = async {
        for line in &handshake {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
        }
        stdin.flush().await
    };
    if let Err(e) = write.await {
        let _ = child.start_kill();
        return Err(format!("failed to query {}: {}", probe, e));
    }

    let mut lines = BufReader::new(stdout).lines();
    let read = async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if v.get("id").and_then(|i| i.as_u64()) != Some(want_id) || v.get("method").is_some() {
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("{} failed", probe)));
            }
            return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
        }
        Err(format!("{} {} closed before answering {}", spec.bin, argv0, probe))
    };
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), read).await;
    let _ = child.start_kill();
    out.unwrap_or_else(|_| Err(format!("{} {} timed out", spec.bin, probe)))
}

#[tauri::command]
pub async fn codex_list_models(
    app: tauri::AppHandle,
    codex_auth: CodexAuth,
) -> Result<serde_json::Value, String> {
    let spec = crate::harness::spec("codex").ok_or_else(|| "codex harness missing".to_string())?;
    let codex_home = write_codex_home(&app, &codex_auth)?;
    let handshake = vec![
        crate::codex_proto::initialize_line(1),
        crate::codex_proto::initialized_line(),
        crate::codex_proto::model_list_line(2),
    ];
    probe_app_server(&app, spec, &codex_home.to_string_lossy(), Some(codex_home.as_path()), handshake, 2, "model/list").await
}

// List the Kimi models the signed-in account can run. ACP has no standalone model-list method
// (providers/list is unimplemented in 0.25.0), but every session/new response advertises the
// model catalog as a configOptions "model" select — so this spawns a THROWAWAY `kimi acp`,
// opens one session, and returns that response's result for the webview to mine (kimiModels.ts).
// Requires the CLI's own login (unauthenticated session/new fails -32000) — callers fall back
// to the static registry list on error.
#[tauri::command]
pub async fn kimi_list_models(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let spec = crate::harness::spec("kimi-code").ok_or_else(|| "kimi harness missing".to_string())?;
    // session/new needs an existing cwd; the user's home dir always is.
    let cwd = {
        use tauri::Manager;
        app.path()
            .home_dir()
            .map_err(|e| format!("no home dir: {e}"))?
            .to_string_lossy()
            .into_owned()
    };
    let handshake = vec![
        crate::kimi_proto::initialize_line(1),
        crate::kimi_proto::session_open_line(2, None, &cwd),
    ];
    probe_app_server(&app, spec, &cwd, None, handshake, 2, "session/new").await
}

// Run a harness turn: stream the CLI's stdout as agent events, honor cancellation. `target`
// (absent for native-login runs) routes the CLI through the local gateway. With a `session_key`
// (the code chat id) a warm-capable harness runs WARM: one long-lived process per chat, follow-up
// turns over its stdio protocol (see session.rs); otherwise each turn spawns a fresh process.
#[tauri::command]
pub async fn agent_run(
    app: tauri::AppHandle,
    harness: String,
    model: String,
    prompt: String,
    images: Vec<ImageInput>,
    cwd: String,
    permission_mode: String,
    effort: String,
    resume: Option<String>,
    target: Option<RouteTarget>,
    codex_auth: Option<CodexAuth>,
    claude_token: Option<String>,
    session_key: Option<String>,
    stream_id: String,
    on_event: tauri::ipc::Channel<PipeEvent>,
) -> Result<(), String> {
    let cancel = cancel_guard(&stream_id);
    let spec = crate::harness::spec(&harness).ok_or_else(|| format!("unknown harness: {}", harness))?;
    let program = match crate::installer::resolve_bin(&app, spec.bin) {
        Some(p) => p,
        None => {
            let msg = format!("'{}' not found — install it from the Environment picker.", spec.bin);
            let _ = on_event.send(PipeEvent::Error(msg.clone()));
            return Err(msg);
        }
    };
    if let Err(e) = ensure_node_for(&app, spec, &program).await {
        let _ = on_event.send(PipeEvent::Error(e.clone()));
        return Err(e);
    }
    let path_env = crate::node_runtime::child_path_env(&app);

    // Warm path: reuse/spawn the chat's live process and feed it this turn over its stdio
    // protocol (claude stream-json / codex app-server JSON-RPC — session.rs begin_turn).
    {
        if let Some(key) = session_key.filter(|k| !k.is_empty()) {
            let is_codex = matches!(spec.channel, PromptChannel::CodexRpc);
            let codex_home = match codex_auth.as_ref().filter(|_| is_codex) {
                Some(a) => Some(write_codex_home(&app, a)?),
                None => None,
            };
            let run = WarmRun {
                fingerprint: crate::session::Fingerprint {
                    harness,
                    model,
                    cwd,
                    // Claude: argv-only knob — an effort change respawns (--resume keeps context).
                    // Codex: per-turn turn/start override — kept out so a change never respawns.
                    // Kimi: no effort surface at all — always out.
                    effort: if matches!(spec.channel, PromptChannel::ClaudeStream) {
                        effort.clone()
                    } else {
                        String::new()
                    },
                    target: target.map(|t| (t.protocol, t.base_url, t.api_key)),
                    claude_token,
                    codex_account: codex_auth.as_ref().map(codex_account_id),
                },
                permission_mode,
                resume,
                prompt,
                images,
                effort,
                path_env,
                codex_home,
            };
            return run_warm(&key, spec, &program, run, &cancel, &stream_id, &on_event).await;
        }
        if matches!(spec.channel, PromptChannel::CodexRpc | PromptChannel::KimiAcp) {
            // Neither app-server nor acp has a one-shot mode — these runs need a session.
            return Err(format!("{} runs require a session key", spec.id));
        }
    }

    let codex_home = match &codex_auth {
        Some(a) => Some(write_codex_home(&app, a)?),
        None => None,
    };
    let target_ref = target.as_ref().map(|t| (t.protocol.as_str(), t.base_url.as_str(), t.api_key.as_str()));
    let (gw, gateway_url) = start_gateway_for(spec, target_ref, &effort).await?;
    // The guard shuts the gateway down on every exit path below (including panics).
    let gateway = GatewayGuard(gw);
    let routed = gateway
        .0
        .as_ref()
        .zip(gateway_url.as_deref())
        .map(|(g, url)| (&spec.env, url, g.token.as_str(), model.as_str()));

    // Built here (not before the gateway) so Arg::RouteArgs can embed the gateway origin.
    let args = build_argv(spec, &model, &permission_mode, &effort, gateway_url.as_deref(), resume.as_deref());

    let mut child = match spawn(&program, &args, &cwd, routed, codex_home.as_deref(), claude_token.as_deref(), path_env.as_deref(), true) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("failed to start '{}': {} (is it installed and on PATH?)", spec.bin, e);
            let _ = on_event.send(PipeEvent::Error(msg.clone()));
            return Err(msg);
        }
    };

    // Claude stream channel: deliver the prompt as a stream-json user message on stdin and keep
    // the pipe open for control_responses (permission answers via agent_respond). The guard
    // closes it on every exit path; the pump loop closes it early at the result line.
    // (Codex never reaches this per-turn path — it always runs warm.)
    let _stdin_guard = StdinGuard { id: stream_id.clone() };
    if matches!(spec.channel, PromptChannel::ClaudeStream) {
        let mut si = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.start_kill();
                return Err("no stdin".to_string());
            }
        };
        let initial = claude_user_line(&prompt, &images);
        let wrote = async {
            si.write_all(initial.as_bytes()).await?;
            si.write_all(b"\n").await?;
            si.flush().await
        }
        .await;
        if let Err(e) = wrote {
            let _ = child.start_kill();
            let msg = format!("failed to send prompt to '{}': {}", spec.bin, e);
            let _ = on_event.send(PipeEvent::Error(msg.clone()));
            return Err(msg);
        }
        agent_stdins()
            .lock()
            .unwrap()
            .insert(stream_id.clone(), Arc::new(tokio::sync::Mutex::new(si)));
    }

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return Err("no stdout".to_string()),
    };
    let mut lines = BufReader::new(stdout).lines();

    loop {
        if cancel.flag.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.start_kill();
            break;
        }
        // Bounded wait so a silent CLI (e.g. stuck retrying upstream) can't pin the loop past a
        // user cancel — on timeout just re-check the flag.
        let next = tokio::time::timeout(std::time::Duration::from_millis(300), lines.next_line()).await;
        match next {
            Err(_) => continue, // idle — no line yet
            Ok(Ok(Some(line))) => {
                // With stream-json input the CLI idles for a next message after `result` — close
                // stdin (drop the handle) so it exits and stdout reaches EOF. Top-level results
                // only (a subagent's sidechain result must not end the turn) — see session.rs.
                let done = matches!(spec.channel, PromptChannel::ClaudeStream)
                    && crate::session::is_result_line(&line);
                // Dumb pipe: forward the raw stdout line; TS decodes it (transform.ts).
                let _ = on_event.send(PipeEvent::Line(line));
                if done {
                    agent_stdins().lock().unwrap().remove(&stream_id);
                }
            }
            Ok(Ok(None)) => break, // stdout closed → process finishing
            Ok(Err(e)) => {
                let _ = on_event.send(PipeEvent::Error(e.to_string()));
                break;
            }
        }
    }

    // Surface a nonzero exit (e.g. auth failure) with whatever stderr carried, unless cancelled.
    // Await the exit (bounded) — at stdout EOF the process may not be reaped yet, and a plain
    // try_wait() would race it and swallow the error.
    if !cancel.flag.load(std::sync::atomic::Ordering::Relaxed) {
        let stderr = child.stderr.take();
        let status = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
        if let Ok(Ok(status)) = status {
            if !status.success() {
                let mut err = String::new();
                if let Some(se) = stderr {
                    use tokio::io::AsyncReadExt;
                    let mut buf = String::new();
                    let _ = BufReader::new(se).read_to_string(&mut buf).await;
                    let tail: Vec<&str> = buf.trim().lines().rev().take(12).collect();
                    err = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
                    if err.chars().count() > 2000 {
                        err = err.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
                    }
                }
                let _ = on_event.send(PipeEvent::Error(if err.trim().is_empty() {
                    format!("{} exited with {}", spec.bin, status)
                } else {
                    err.trim().to_string()
                }));
            }
        }
    }

    let _ = on_event.send(PipeEvent::Done);
    Ok(())
}

// Everything a warm turn needs beyond the shared prelude. The fingerprint doubles as the spawn
// config (model/cwd/target/auth); permission mode and resume are spawn/turn-time knobs kept out
// of it (see session::Fingerprint).
struct WarmRun {
    fingerprint: crate::session::Fingerprint,
    permission_mode: String,
    resume: Option<String>,
    prompt: String,
    // Images attached to this turn (per-turn content, not part of the fingerprint).
    images: Vec<ImageInput>,
    // Raw effort as picked in the UI. For claude it's already in the fingerprint (argv);
    // for codex it rides each turn/start (session.begin_turn) and stays out of the fingerprint.
    effort: String,
    path_env: Option<std::ffi::OsString>,
    // Materialized CODEX_HOME for a native codex run (None for claude / no forwarded auth).
    codex_home: Option<std::path::PathBuf>,
}

// Fingerprint component for the ChatGPT account a codex run uses: auth rotation must respawn the
// warm process so it re-reads the freshly materialized CODEX_HOME/auth.json. In-process identity
// only (never persisted), so DefaultHasher is fine.
fn codex_account_id(auth: &CodexAuth) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    auth.access_token.hash(&mut h);
    format!("{}:{:x}", auth.account_id, h.finish())
}

// One turn against the chat's warm session: reuse the live process when the run identity matches,
// else (re)spawn (claude --resume / codex thread-resume); deliver the turn over the session's
// protocol (begin_turn); wait for the pump to see the protocol's turn-end marker. Cancel
// interrupts in-place (process stays warm) and only kills a deaf CLI.
async fn run_warm(
    key: &str,
    spec: &'static HarnessSpec,
    program: &std::path::Path,
    run: WarmRun,
    cancel: &crate::stream::CancelGuard,
    stream_id: &str,
    on_event: &tauri::ipc::Channel<PipeEvent>,
) -> Result<(), String> {
    // Permission answers route by stream id (agent_respond) — the guard drops this turn's
    // stdin registration on every exit path, mirroring the per-turn flow.
    let _stdin_guard = StdinGuard { id: stream_id.to_string() };

    // A process that died silently between turns only surfaces as a write failure — retry once
    // against a fresh spawn. abandon_turn (not detach) keeps the webview stream open for take two.
    let mut attempt = 0;
    let (session, mut done_rx) = loop {
        attempt += 1;
        let session = match crate::session::get(key).filter(|s| s.matches(&run.fingerprint)) {
            Some(s) => s,
            None => {
                // Stale session under this key (config changed / process dead): drop it first.
                if let Some(old) = crate::session::remove(key) {
                    old.close().await;
                }
                match spawn_warm(key, spec, program, &run).await {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = on_event.send(PipeEvent::Error(e.clone()));
                        return Err(e);
                    }
                }
            }
        };
        if let Some(stdin) = session.stdin() {
            agent_stdins().lock().unwrap().insert(stream_id.to_string(), stdin);
        }
        agent_session_keys().lock().unwrap().insert(stream_id.to_string(), key.to_string());
        let done_rx = session.attach_turn(on_event.clone());
        let wrote = session
            .begin_turn(&run.prompt, &run.images, &run.fingerprint.model, &run.effort, &run.permission_mode)
            .await;
        match wrote {
            Ok(()) => break (session, done_rx),
            Err(e) => {
                session.abandon_turn();
                crate::session::close_session(key).await;
                if attempt >= 2 {
                    let msg = format!("failed to send prompt to '{}': {}", spec.bin, e);
                    let _ = on_event.send(PipeEvent::Error(msg.clone()));
                    return Err(msg);
                }
            }
        }
    };

    // Wait for the turn, polling the shared cancel flag like every pump loop (bounded 300ms).
    loop {
        if cancel.flag.load(std::sync::atomic::Ordering::Relaxed) {
            // Stop the turn but keep the process warm; the CLI acks and closes the turn with an
            // error_during_execution result. A CLI that stays silent for 5s gets killed.
            let interrupted = session.interrupt().await.is_ok();
            let ended = interrupted
                && tokio::time::timeout(std::time::Duration::from_secs(5), &mut done_rx)
                    .await
                    .is_ok();
            if !ended {
                session.detach_turn();
                session.kill().await;
                if let Some(current) = crate::session::get(key) {
                    if Arc::ptr_eq(&current, &session) {
                        crate::session::remove(key);
                    }
                }
            }
            break;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(300), &mut done_rx).await {
            Ok(_) => break, // turn finished (or the session was torn down) — pump sent Done
            Err(_) => continue,
        }
    }
    session.touch();
    Ok(())
}

// Spawn a fresh warm CLI for this chat: session-lifetime gateway on routed runs, argv with
// --resume when a prior session id exists, registry insert (evicting over the LRU cap).
async fn spawn_warm(
    key: &str,
    spec: &'static HarnessSpec,
    program: &std::path::Path,
    run: &WarmRun,
) -> Result<Arc<crate::session::AgentSession>, String> {
    let target_ref = run
        .fingerprint
        .target
        .as_ref()
        .map(|(p, b, k)| (p.as_str(), b.as_str(), k.as_str()));
    // Claude keeps effort in its fingerprint, so a change respawns the session and rebuilds this
    // gateway with the new level. Codex carries effort per turn/start instead, but its runs are
    // openai-inbound and never hit the translation that reads this field.
    let (gateway, gateway_url) = start_gateway_for(spec, target_ref, &run.effort).await?;
    let routed = gateway
        .as_ref()
        .zip(gateway_url.as_deref())
        .map(|(g, url)| (&spec.env, url, g.token.as_str(), run.fingerprint.model.as_str()));
    // The prompt goes over the stdio protocol, never argv. For codex, resume also rides the
    // protocol (thread/resume below) — Arg::Resume only fires for claude.
    let args = build_argv(
        spec,
        &run.fingerprint.model,
        &run.permission_mode,
        &run.fingerprint.effort,
        gateway_url.as_deref(),
        run.resume.as_deref(),
    );
    let child = match spawn(
        program,
        &args,
        &run.fingerprint.cwd,
        routed,
        run.codex_home.as_deref(),
        run.fingerprint.claude_token.as_deref(),
        run.path_env.as_deref(),
        true,
    ) {
        Ok(c) => c,
        Err(e) => {
            if let Some(g) = &gateway {
                g.shutdown();
            }
            return Err(format!("failed to start '{}': {} (is it installed and on PATH?)", spec.bin, e));
        }
    };
    let proto = match spec.channel {
        PromptChannel::CodexRpc => crate::session::SessionProto::Codex(crate::session::CodexRuntime::new()),
        PromptChannel::KimiAcp => crate::session::SessionProto::Kimi(crate::session::KimiRuntime::new(run.resume.clone())),
        PromptChannel::ClaudeStream => crate::session::SessionProto::Claude,
    };
    // A fresh kimi acp session always boots in "default" mode regardless of what the user picked
    // (argv knobs don't bind — probe P8); register that truth so begin_turn's reconcile fires the
    // session/set_mode on the first turn instead of assuming the pick took.
    let initial_mode = match spec.channel {
        PromptChannel::KimiAcp => "default".to_string(),
        _ => run.permission_mode.clone(),
    };
    let (session, evicted) = crate::session::spawn_session(
        key,
        run.fingerprint.clone(),
        proto,
        initial_mode,
        child,
        gateway,
    )?;
    // Over the warm cap (or a same-key replacement): gracefully drop the losers.
    for old in evicted {
        old.close().await;
    }
    // Codex handshake, pipelined without awaiting responses (probe-verified): initialize +
    // initialized + thread open. The pump consumes the thread response and unblocks begin_turn.
    if matches!(spec.channel, PromptChannel::CodexRpc) {
        let handshake = async {
            session.write_line(&crate::codex_proto::initialize_line(1)).await?;
            session.write_line(&crate::codex_proto::initialized_line()).await?;
            session
                .write_line(&crate::codex_proto::thread_open_line(
                    2,
                    run.resume.as_deref().filter(|s| !s.is_empty()),
                    &run.fingerprint.model,
                    &run.fingerprint.cwd,
                    &run.permission_mode,
                ))
                .await
        }
        .await;
        if let Err(e) = handshake {
            crate::session::close_session(key).await;
            return Err(format!("failed to start '{}' app-server: {}", spec.bin, e));
        }
    }
    // Kimi handshake, same pipelined pattern (probe-verified 0.25.0): initialize + session open
    // (session/new, or session/resume with a prior id — resume replays no history, matching the
    // webview's own transcript). Model and permission mode ride begin_turn (no spawn-time knobs).
    if matches!(spec.channel, PromptChannel::KimiAcp) {
        let handshake = async {
            session.write_line(&crate::kimi_proto::initialize_line(1)).await?;
            session
                .write_line(&crate::kimi_proto::session_open_line(
                    2,
                    run.resume.as_deref().filter(|s| !s.is_empty()),
                    &run.fingerprint.cwd,
                ))
                .await
        }
        .await;
        if let Err(e) = handshake {
            crate::session::close_session(key).await;
            return Err(format!("failed to start '{}' acp: {}", spec.bin, e));
        }
    }
    Ok(session)
}

// Drop a chat's warm CLI session (chat deleted in the sidebar, or an explicit reset).
#[tauri::command]
pub async fn agent_session_close(session_key: String) {
    crate::session::close_session(&session_key).await;
}

#[cfg(test)]
mod tests {
    // build_argv reads the private HarnessSpec argv templates, so it's tested inline (matching
    // gateway.rs) rather than from tests/, which would force a wide pub cascade.
    use super::*;
    use crate::harness::spec;

    #[test]
    fn build_argv_claude_carries_model_permission_and_control_protocol() {
        let s = spec("claude-code").unwrap();
        let argv = build_argv(s, "claude-x", "plan", "", None, None);
        assert!(argv.contains(&"-p".to_string()));
        // Prompt goes over stdin (PromptChannel::ClaudeStream), never argv.
        assert!(matches!(s.channel, PromptChannel::ClaudeStream));
        assert!(argv.windows(2).any(|w| w[0] == "--input-format" && w[1] == "stream-json"));
        assert!(argv.windows(2).any(|w| w[0] == "--permission-prompt-tool" && w[1] == "stdio"));
        let mi = argv.iter().position(|a| a == "--model").unwrap();
        assert_eq!(argv[mi + 1], "claude-x");
        assert!(argv.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "plan"));
    }

    #[test]
    fn build_argv_omits_model_flag_when_no_model_picked() {
        let s = spec("claude-code").unwrap();
        assert!(!build_argv(s, "", "", "", None, None).contains(&"--model".to_string()));
    }

    #[test]
    fn build_argv_claude_emits_effort_only_when_resolved() {
        let s = spec("claude-code").unwrap();
        assert!(!build_argv(s, "", "", "", None, None).contains(&"--effort".to_string()));
        let argv = build_argv(s, "", "", "high", None, None);
        let ei = argv.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(argv[ei + 1], "high");
    }

    #[test]
    fn build_argv_codex_is_app_server_with_route_args_only_on_a_routed_run() {
        let s = spec("codex").unwrap();
        let native = build_argv(s, "gpt", "plan", "high", None, Some("thread-1"));
        assert_eq!(native[0], "app-server");
        // model / effort / permission / resume all ride the JSON-RPC protocol, never argv
        assert!(!native.iter().any(|a| a == "--model" || a == "gpt"));
        assert!(!native.iter().any(|a| a.contains("thread-1") || a.contains("high")));
        assert!(!native.iter().any(|a| a == "model_provider=modelius"));
        let routed = build_argv(s, "gpt", "", "", Some("http://127.0.0.1:9000"), None);
        assert!(routed.iter().any(|a| a == "model_provider=modelius"));
        assert!(routed
            .iter()
            .any(|a| a == "model_providers.modelius.base_url=http://127.0.0.1:9000/v1")); // {url} substituted
    }

    #[test]
    fn build_argv_kimi_is_the_bare_acp_subcommand() {
        // No spawn-time knobs bind under `acp` (probe P8): model rides session/set_model, mode
        // rides session/set_mode, resume rides session/resume — argv stays ["acp"] no matter what.
        let s = spec("kimi-code").unwrap();
        assert!(matches!(s.channel, PromptChannel::KimiAcp));
        assert_eq!(build_argv(s, "", "", "", None, None), vec!["acp"]);
        assert_eq!(
            build_argv(s, "kimi-k2.7-code", "bypassPermissions", "high", None, Some("session_prev")),
            vec!["acp"]
        );
    }

    #[test]
    fn build_argv_claude_emits_resume_flag_only_with_an_id() {
        let s = spec("claude-code").unwrap();
        assert!(!build_argv(s, "", "", "", None, Some("")).contains(&"--resume".to_string()));
        let argv = build_argv(s, "", "", "", None, Some("sess-1"));
        let ri = argv.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(argv[ri + 1], "sess-1");
    }

    #[test]
    fn set_mode_of_extracts_only_a_control_response_set_mode() {
        let v = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap();
        // plan-approve answer: allow + updatedPermissions setMode (the shape permission.ts builds)
        let approve = v(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"behavior":"allow","updatedInput":{},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}"#);
        assert_eq!(set_mode_of(&approve).as_deref(), Some("acceptEdits"));
        // plain allow without a mode switch
        let plain = v(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"behavior":"allow","updatedInput":{}}}}"#);
        assert_eq!(set_mode_of(&plain), None);
        // deny carries no permissions either
        let deny = v(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"behavior":"deny","message":"no"}}}"#);
        assert_eq!(set_mode_of(&deny), None);
        // codex/kimi JSON-RPC answers are not control_responses
        let codex = v(r#"{"id":3,"result":{"decision":"accept"}}"#);
        assert_eq!(set_mode_of(&codex), None);
        // a non-setMode permission entry is ignored
        let other = v(r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[]}]}}}"#);
        assert_eq!(set_mode_of(&other), None);
    }

    #[test]
    fn codex_account_id_tracks_token_rotation() {
        let auth = |tok: &str| CodexAuth {
            id_token: "id".into(),
            access_token: tok.into(),
            refresh_token: None,
            account_id: "acc-1".into(),
        };
        assert_eq!(codex_account_id(&auth("t1")), codex_account_id(&auth("t1")));
        assert_ne!(codex_account_id(&auth("t1")), codex_account_id(&auth("t2")));
        assert!(codex_account_id(&auth("t1")).starts_with("acc-1:"));
        // the raw token itself must never appear in the fingerprint component
        assert!(!codex_account_id(&auth("supersecrettoken")).contains("supersecrettoken"));
    }
}
