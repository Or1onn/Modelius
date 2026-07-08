// agent.rs — run an external agentic coding CLI as a subprocess, decode its stdout with the
// parser its HarnessSpec names (see harness.rs), and forward transcript events to the webview
// over a Tauri channel. Non-native model picks route the CLI through the per-run local gateway
// (see gateway.rs) so the real provider key never enters the CLI process.
// Mirrors the LLM streaming path (see stream.rs / compat.rs): one command, events over a Channel,
// cancellation via the shared cancel registry.
use crate::harness::{Arg, EnvSpec, HarnessSpec, OutputFormat};
use crate::stream::cancel_guard;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// Transcript events sent back to the webview. Shape mirrors the front-end Step union
// (see pages/code/ui/CodeScreen.tsx): text prose, tool-call rows, run-command rows, a final result.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum AgentEvent {
    Text(String),
    // A reasoning/thinking trace segment (rendered as a collapsible block, like chat mode).
    Thinking(String),
    // A tool call the agent made: id (to match its later result) + verb (Read/Edit/Bash/PowerShell/…)
    // + the file the tool touched or the command it ran. For Edit/Write, `edit` carries the before/after
    // text so the front end can render a colored diff instead of the raw tool_result.
    ToolUse { id: String, verb: String, file: String, edit: Option<EditDiff> },
    // The result of a prior tool call, matched to the ToolUse by id. `output` is truncated.
    ToolResult { id: String, output: String },
    // Terminal success: the model that answered, optional total cost (USD), and the prompt-token
    // count of the final turn (input + cache tokens) — how full the model's context window is.
    Result { model: String, cost: Option<f64>, context_tokens: u64 },
    Error(String),
    Done,
}

// Before/after text for an Edit (old_string → new_string) or Write (empty → content).
#[derive(Clone, serde::Serialize)]
pub(crate) struct EditDiff {
    old: String,
    new: String,
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
// Arg::RouteArgs; the gateway token is never placed in argv (env-only).
fn build_argv(
    spec: &HarnessSpec,
    prompt: &str,
    model: &str,
    permission_mode: &str,
    gateway_url: Option<&str>,
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
// CLI on the account connected in Orchestro instead of requiring a separate `codex login`.
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

// Cap diff text so a large Edit/Write can't flood the transcript (char-safe, no marker).
fn cap(s: &str) -> String {
    const MAX: usize = 8000;
    if s.chars().count() <= MAX { s.to_string() } else { s.chars().take(MAX).collect() }
}

// Cap tool output so a big file read can't flood the transcript (char-safe).
fn truncate(s: &str) -> String {
    const MAX: usize = 4000;
    let s = s.trim_end();
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{}\n… (truncated)", cut)
}

// Stateful stdout decoder, one variant per OutputFormat. `handle` maps one line into agent
// events and returns true on the terminal event; `finish` runs at EOF for whole-document formats.
enum Parser {
    Claude,
    Codex { started: std::collections::HashSet<String> },
    Plain,
}

impl Parser {
    fn new(format: OutputFormat) -> Self {
        match format {
            OutputFormat::ClaudeStreamJson => Parser::Claude,
            OutputFormat::CodexJsonl => Parser::Codex { started: std::collections::HashSet::new() },
            OutputFormat::PlainText => Parser::Plain,
        }
    }

    fn handle(&mut self, line: &str, on_event: &tauri::ipc::Channel<AgentEvent>) -> bool {
        match self {
            Parser::Claude => handle_claude_line(line, on_event),
            Parser::Codex { started } => handle_codex_line(line, on_event, started),
            Parser::Plain => {
                if !line.trim().is_empty() {
                    let _ = on_event.send(AgentEvent::Text(line.to_string()));
                }
                false
            }
        }
    }

    fn finish(&mut self, _on_event: &tauri::ipc::Channel<AgentEvent>) {}
}

// Map one line of Claude Code stream-json into agent events. Returns true on the terminal `result`.
// Qwen Code's stream-json emits the same event shapes, so it shares this decoder.
fn handle_claude_line(line: &str, on_event: &tauri::ipc::Channel<AgentEvent>) -> bool {
    let Ok(j) = serde_json::from_str::<serde_json::Value>(line) else { return false };
    match j.get("type").and_then(|v| v.as_str()) {
        Some("assistant") => {
            if let Some(content) = j.pointer("/message/content").and_then(|v| v.as_array()) {
                for block in content {
                    match block.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                if !t.trim().is_empty() {
                                    let _ = on_event.send(AgentEvent::Text(t.to_string()));
                                }
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = block.get("thinking").and_then(|v| v.as_str()) {
                                if !t.trim().is_empty() {
                                    let _ = on_event.send(AgentEvent::Thinking(t.to_string()));
                                }
                            }
                        }
                        Some("tool_use") => {
                            let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("Tool");
                            let input = block.get("input");
                            let get = |k: &str| input.and_then(|i| i.get(k)).and_then(|v| v.as_str());
                            // Primary target: a shell command (Bash/PowerShell/…), else the file/path/pattern
                            // the tool acted on. Covers file tools, shell tools, and MCP tools uniformly.
                            let file = get("command").or_else(|| get("file_path")).or_else(|| get("path")).or_else(|| get("pattern")).unwrap_or("");
                            // Edit/Write → carry before/after text for a rendered diff (capped so a big write can't flood).
                            let edit = if name.eq_ignore_ascii_case("edit") {
                                Some(EditDiff { old: cap(get("old_string").unwrap_or("")), new: cap(get("new_string").unwrap_or("")) })
                            } else if name.eq_ignore_ascii_case("write") {
                                Some(EditDiff { old: String::new(), new: cap(get("content").unwrap_or("")) })
                            } else if name.eq_ignore_ascii_case("multiedit") {
                                // Combine every edit's before/after into one diff (join in edit order).
                                input.and_then(|i| i.get("edits")).and_then(|v| v.as_array()).map(|edits| {
                                    let join = |key: &str| edits.iter().filter_map(|e| e.get(key).and_then(|v| v.as_str())).collect::<Vec<_>>().join("\n");
                                    EditDiff { old: cap(&join("old_string")), new: cap(&join("new_string")) }
                                })
                            } else {
                                None
                            };
                            let _ = on_event.send(AgentEvent::ToolUse { id, verb: name.to_string(), file: file.to_string(), edit });
                        }
                        _ => {}
                    }
                }
            }
            false
        }
        // tool_result blocks arrive as `user` messages; match them to their ToolUse by id.
        Some("user") => {
            if let Some(content) = j.pointer("/message/content").and_then(|v| v.as_array()) {
                for block in content {
                    if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                        let id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let output = truncate(&crate::gateway::tool_result_text(block.get("content")));
                        if !output.is_empty() {
                            let _ = on_event.send(AgentEvent::ToolResult { id, output });
                        }
                    }
                }
            }
            false
        }
        Some("result") => {
            let model = j.pointer("/modelUsage").and_then(|m| m.as_object()).and_then(|m| m.keys().next().cloned()).unwrap_or_default();
            let cost = j.get("total_cost_usd").and_then(|v| v.as_f64());
            // Prompt tokens of the final request = how full the context window is.
            let u = |k: &str| j.pointer(&format!("/usage/{}", k)).and_then(|v| v.as_u64()).unwrap_or(0);
            let context_tokens = u("input_tokens") + u("cache_creation_input_tokens") + u("cache_read_input_tokens");
            let _ = on_event.send(AgentEvent::Result { model, cost, context_tokens });
            true
        }
        _ => false,
    }
}

// Map one line of `codex exec --json` JSONL into agent events. Returns true on the terminal
// turn.completed / turn.failed / stream error. `started` tracks command items whose ToolUse was
// already sent on item.started, so item.completed only patches in the result.
fn handle_codex_line(
    line: &str,
    on_event: &tauri::ipc::Channel<AgentEvent>,
    started: &mut std::collections::HashSet<String>,
) -> bool {
    let Ok(j) = serde_json::from_str::<serde_json::Value>(line) else { return false };
    let ev = j.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ev {
        "turn.completed" => {
            let u = |k: &str| j.pointer(&format!("/usage/{}", k)).and_then(|v| v.as_u64()).unwrap_or(0);
            let _ = on_event.send(AgentEvent::Result {
                model: String::new(),
                cost: None,
                context_tokens: u("input_tokens") + u("cached_input_tokens"),
            });
            true
        }
        "turn.failed" => {
            let msg = j.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("turn failed");
            let _ = on_event.send(AgentEvent::Error(msg.to_string()));
            true
        }
        "error" => {
            let msg = j.get("message").and_then(|v| v.as_str()).unwrap_or("stream error");
            let _ = on_event.send(AgentEvent::Error(msg.to_string()));
            true
        }
        "item.started" | "item.completed" => {
            let item = j.get("item").unwrap_or(&serde_json::Value::Null);
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let get = |k: &str| item.get(k).and_then(|v| v.as_str()).unwrap_or("");
            let completed = ev == "item.completed";
            match item.get("type").and_then(|v| v.as_str()) {
                Some("agent_message") if completed => {
                    let t = get("text");
                    if !t.trim().is_empty() {
                        let _ = on_event.send(AgentEvent::Text(t.to_string()));
                    }
                }
                Some("reasoning") if completed => {
                    let t = get("text");
                    if !t.trim().is_empty() {
                        let _ = on_event.send(AgentEvent::Thinking(t.to_string()));
                    }
                }
                Some("command_execution") => {
                    if started.insert(id.clone()) {
                        let _ = on_event.send(AgentEvent::ToolUse {
                            id: id.clone(),
                            verb: "Ran".to_string(),
                            file: get("command").to_string(),
                            edit: None,
                        });
                    }
                    if completed {
                        let out = truncate(get("aggregated_output"));
                        if !out.is_empty() {
                            let _ = on_event.send(AgentEvent::ToolResult { id, output: out });
                        }
                    }
                }
                Some("file_change") if completed => {
                    for (i, ch) in item.get("changes").and_then(|v| v.as_array()).unwrap_or(&Vec::new()).iter().enumerate() {
                        let verb = match ch.get("kind").and_then(|v| v.as_str()) {
                            Some("add") => "Write",
                            Some("delete") => "Deleted",
                            _ => "Edit",
                        };
                        let _ = on_event.send(AgentEvent::ToolUse {
                            id: format!("{}:{}", id, i),
                            verb: verb.to_string(),
                            file: ch.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            edit: None,
                        });
                    }
                }
                Some("mcp_tool_call") => {
                    if started.insert(id.clone()) {
                        let _ = on_event.send(AgentEvent::ToolUse {
                            id: id.clone(),
                            verb: get("tool").to_string(),
                            file: get("server").to_string(),
                            edit: None,
                        });
                    }
                    if completed {
                        let out = truncate(&item.get("result").map(|v| if v.is_string() { v.as_str().unwrap_or("").to_string() } else { v.to_string() }).unwrap_or_default());
                        if !out.is_empty() {
                            let _ = on_event.send(AgentEvent::ToolResult { id, output: out });
                        }
                    }
                }
                Some("web_search") if completed => {
                    let _ = on_event.send(AgentEvent::ToolUse {
                        id,
                        verb: "Searched".to_string(),
                        file: get("query").to_string(),
                        edit: None,
                    });
                }
                // An `error` *item* is a non-fatal notice (e.g. the model-metadata warning); Codex
                // keeps going. Surface it as prose, not an AgentEvent::Error — the front end treats
                // Error as terminal and would stop rendering the rest of the run. Real failures
                // arrive as turn.failed / a top-level error event (both terminal, handled above).
                Some("error") if completed => {
                    let t = get("message");
                    if !t.trim().is_empty() {
                        let _ = on_event.send(AgentEvent::Text(format!("⚠️ {}", t)));
                    }
                }
                _ => {} // todo_list / item.updated noise
            }
            false
        }
        _ => false, // thread.started / turn.started
    }
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
    target: Option<RouteTarget>,
    codex_auth: Option<CodexAuth>,
    claude_token: Option<String>,
    stream_id: String,
    on_event: tauri::ipc::Channel<AgentEvent>,
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
            let _ = on_event.send(AgentEvent::Error(msg.clone()));
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
            let _ = on_event.send(AgentEvent::Error(e.clone()));
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
    let args = build_argv(spec, &prompt, &model, &permission_mode, gateway_url.as_deref());

    let mut child = match spawn(&program, &args, &cwd, spec.extra_env, routed, codex_home.as_deref(), claude_token.as_deref(), path_env.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            if let Some(g) = &gateway {
                g.shutdown();
            }
            let msg = format!("failed to start '{}': {} (is it installed and on PATH?)", spec.bin, e);
            let _ = on_event.send(AgentEvent::Error(msg.clone()));
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
    let mut parser = Parser::new(spec.output);

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
                if parser.handle(&line, &on_event) {
                    break;
                }
            }
            Ok(Ok(None)) => {
                // stdout closed → process finishing; whole-document formats decode now.
                parser.finish(&on_event);
                break;
            }
            Ok(Err(e)) => {
                let _ = on_event.send(AgentEvent::Error(e.to_string()));
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
                let _ = on_event.send(AgentEvent::Error(if err.trim().is_empty() {
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
    let _ = on_event.send(AgentEvent::Done);
    Ok(())
}
