// agent.rs — run an external agentic coding CLI as a subprocess and forward its raw stdout lines
// to the webview over a Tauri channel (a "dumb pipe"). All decoding of the CLI's stream-json /
// JSONL into the AI SDK UIMessageChunk model happens in TS (features/run-agent/lib/transform.ts).
// Non-native model picks route the CLI through the per-run local gateway (see gateway.rs) so the
// real provider key never enters the CLI process.
// Mirrors the LLM streaming path (see stream.rs / compat.rs): one command, events over a Channel,
// cancellation via the shared cancel registry.
use crate::harness::{Arg, EnvSpec, HarnessSpec};
use crate::stream::cancel_guard;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// Events sent back to the webview. `Line` carries one raw stdout line from the CLI (decoded in TS);
// `Error` is a spawn/exit failure; `Done` marks stdout EOF.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum PipeEvent {
    Line(String),
    Error(String),
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

// Build argv from the harness's declarative template. The prompt is passed as a distinct argv
// entry (never shell-interpolated). `gateway_url` (Some on a routed run) fills the {url} slot in
// Arg::RouteArgs; the gateway token is never placed in argv (env-only). `resume` (a session id
// captured from a prior run) fills the {id} slot in Arg::Resume.
fn build_argv(
    spec: &HarnessSpec,
    prompt: &str,
    model: &str,
    permission_mode: &str,
    gateway_url: Option<&str>,
    resume: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    for a in spec.argv {
        match a {
            Arg::Lit(s) => args.push((*s).to_string()),
            Arg::Prompt => args.push(prompt.to_string()),
            Arg::ModelFlag(flag) => {
                if !model.is_empty() {
                    args.push((*flag).to_string());
                    args.push(model.to_string());
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
    extra_env: &[(&str, &str)],
    routed: Option<(&EnvSpec, &str, &str, &str)>,
    codex_home: Option<&std::path::Path>,
    claude_token: Option<&str>,
    path_env: Option<&std::ffi::OsStr>,
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = Command::new(program);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if let Some((env, gateway_url, token, model)) = routed {
        for k in env.base_url {
            cmd.env(k, format!("{}{}", gateway_url, env.base_url_suffix));
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

// Run a harness turn: spawn the CLI in `cwd`, stream its stdout as agent events, honor cancellation.
// `target` (absent for native-login runs) starts the per-run gateway and re-points the CLI at it.
#[tauri::command]
pub async fn agent_run(
    app: tauri::AppHandle,
    harness: String,
    model: String,
    prompt: String,
    cwd: String,
    permission_mode: String,
    resume: Option<String>,
    target: Option<RouteTarget>,
    codex_auth: Option<CodexAuth>,
    claude_token: Option<String>,
    stream_id: String,
    on_event: tauri::ipc::Channel<PipeEvent>,
) -> Result<(), String> {
    let cancel = cancel_guard(&stream_id);
    let spec = crate::harness::spec(&harness).ok_or_else(|| format!("unknown harness: {}", harness))?;
    let codex_home = match &codex_auth {
        Some(a) => Some(write_codex_home(&app, a)?),
        None => None,
    };
    let program = match crate::installer::resolve_bin(&app, spec.bin) {
        Some(p) => p,
        None => {
            let msg = format!("'{}' not found — install it from the Environment picker.", spec.bin);
            let _ = on_event.send(PipeEvent::Error(msg.clone()));
            return Err(msg);
        }
    };
    // npm-shipped CLIs are Node programs. If the system Node is missing or broken, silently
    // provision the app's portable runtime (one-time download) so the CLI's `node` shim never
    // picks a bad install. Script-shipped CLIs (Go binaries) don't need Node at all.
    if matches!(spec.install, crate::harness::Install::Npm(_))
        && !crate::node_runtime::system_node_acceptable()
    {
        if let Err(e) = crate::node_runtime::ensure(&app).await {
            let _ = on_event.send(PipeEvent::Error(e.clone()));
            return Err(e);
        }
    }
    let path_env = crate::node_runtime::child_path_env(&app);

    let gateway = match &target {
        Some(t) => {
            let outbound = match t.protocol.as_str() {
                "anthropic" => crate::gateway::Proto::Anthropic,
                "openai" => crate::gateway::Proto::OpenAi,
                other => return Err(format!("unknown target protocol: {}", other)),
            };
            Some(
                crate::gateway::start(crate::gateway::GatewayConfig {
                    inbound: spec.protocol,
                    outbound,
                    target_base: t.base_url.clone(),
                    api_key: t.api_key.clone(),
                })
                .await
                .map_err(|e| format!("failed to start gateway: {}", e))?,
            )
        }
        None => None,
    };

    let gateway_url = gateway.as_ref().map(|g| format!("http://127.0.0.1:{}", g.port));
    let routed = gateway
        .as_ref()
        .zip(gateway_url.as_deref())
        .map(|(g, url)| (&spec.env, url, g.token.as_str(), model.as_str()));

    // Built here (not before the gateway) so Arg::RouteArgs can embed the gateway origin.
    let args = build_argv(spec, &prompt, &model, &permission_mode, gateway_url.as_deref(), resume.as_deref());

    let mut child = match spawn(&program, &args, &cwd, spec.extra_env, routed, codex_home.as_deref(), claude_token.as_deref(), path_env.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            if let Some(g) = &gateway {
                g.shutdown();
            }
            let msg = format!("failed to start '{}': {} (is it installed and on PATH?)", spec.bin, e);
            let _ = on_event.send(PipeEvent::Error(msg.clone()));
            return Err(msg);
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            if let Some(g) = &gateway {
                g.shutdown();
            }
            return Err("no stdout".to_string());
        }
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
                // Dumb pipe: forward the raw stdout line; TS decodes it (transform.ts).
                let _ = on_event.send(PipeEvent::Line(line));
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

    if let Some(g) = &gateway {
        g.shutdown();
    }
    let _ = on_event.send(PipeEvent::Done);
    Ok(())
}

#[cfg(test)]
mod tests {
    // build_argv reads the private HarnessSpec argv templates, so it's tested inline (matching
    // gateway.rs) rather than from tests/, which would force a wide pub cascade.
    use super::*;
    use crate::harness::spec;

    #[test]
    fn build_argv_claude_carries_prompt_model_and_permission() {
        let s = spec("claude-code").unwrap();
        let argv = build_argv(s, "do it", "claude-x", "plan", None, None);
        assert!(argv.contains(&"-p".to_string()));
        assert!(argv.contains(&"do it".to_string())); // prompt is its own argv entry
        let mi = argv.iter().position(|a| a == "--model").unwrap();
        assert_eq!(argv[mi + 1], "claude-x");
        assert!(argv.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "plan"));
    }

    #[test]
    fn build_argv_omits_model_flag_when_no_model_picked() {
        let s = spec("claude-code").unwrap();
        assert!(!build_argv(s, "hi", "", "", None, None).contains(&"--model".to_string()));
    }

    #[test]
    fn build_argv_codex_emits_route_args_only_on_a_routed_run() {
        let s = spec("codex").unwrap();
        let native = build_argv(s, "hi", "gpt", "", None, None);
        assert!(!native.iter().any(|a| a == "model_provider=modelius"));
        let routed = build_argv(s, "hi", "gpt", "", Some("http://127.0.0.1:9000"), None);
        assert!(routed.iter().any(|a| a == "model_provider=modelius"));
        assert!(routed
            .iter()
            .any(|a| a == "model_providers.modelius.base_url=http://127.0.0.1:9000/v1")); // {url} substituted
    }

    #[test]
    fn build_argv_claude_emits_resume_flag_only_with_an_id() {
        let s = spec("claude-code").unwrap();
        assert!(!build_argv(s, "hi", "", "", None, Some("")).contains(&"--resume".to_string()));
        let argv = build_argv(s, "hi", "", "", None, Some("sess-1"));
        let ri = argv.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(argv[ri + 1], "sess-1");
    }

    #[test]
    fn build_argv_codex_resume_subcommand_directly_follows_exec() {
        let s = spec("codex").unwrap();
        assert!(!build_argv(s, "hi", "", "", None, None).contains(&"resume".to_string()));
        let argv = build_argv(s, "hi", "", "", None, Some("thread-1"));
        assert_eq!(argv[0], "exec");
        assert_eq!(argv[1], "resume");
        assert_eq!(argv[2], "thread-1");
        assert_eq!(argv.last().unwrap(), "hi"); // prompt stays the trailing positional
    }
}
