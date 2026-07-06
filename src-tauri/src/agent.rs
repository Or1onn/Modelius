// agent.rs — run an external agentic coding CLI (Claude Code headless first) as a subprocess,
// parse its stream-json stdout, and forward transcript events to the webview over a Tauri channel.
// Mirrors the LLM streaming path (see stream.rs / compat.rs): one command, events over a Channel,
// cancellation via the shared cancel registry.
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

// Build the argv for a harness. Only Claude Code (headless) for now; other harnesses slot in here.
// Returns (program, args). The prompt is passed as a distinct argv entry (never shell-interpolated).
fn build_argv(harness: &str, prompt: &str, model: &str, permission_mode: &str) -> Result<(String, Vec<String>), String> {
    match harness {
        "claude-code" => {
            let mut args = vec![
                "-p".to_string(),
                prompt.to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(), // required for stream-json under -p
            ];
            if !model.is_empty() {
                args.push("--model".to_string());
                args.push(model.to_string());
            }
            if !permission_mode.is_empty() {
                args.push("--permission-mode".to_string());
                args.push(permission_mode.to_string());
            }
            Ok(("claude".to_string(), args))
        }
        other => Err(format!("unknown harness: {}", other)),
    }
}

// Spawn the harness CLI. Resolve the executable on PATH first (on Windows this finds `claude.cmd`
// or `claude.exe`, which a bare name wouldn't), then invoke it directly. Invoking directly — instead
// of routing through `cmd /C` — leaves Rust std as the only layer that escapes arguments; std safely
// quotes args for batch files and refuses ones it can't (BatBadBut / CVE-2024-24576), so a crafted
// prompt cannot break out into a shell command.
fn spawn(program: &str, args: &[String], cwd: &str) -> std::io::Result<tokio::process::Child> {
    let resolved = which::which(program).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::NotFound, format!("'{}' not found on PATH: {}", program, e))
    })?;
    let mut cmd = Command::new(resolved);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    cmd.spawn()
}

// A tool_result's `content` is either a raw string or an array of {type:"text", text} blocks.
fn result_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(v) if v.is_string() => v.as_str().unwrap_or("").to_string(),
        Some(v) if v.is_array() => v
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
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

// Map one line of Claude Code stream-json into agent events. Returns true on the terminal `result`.
fn handle_line(line: &str, on_event: &tauri::ipc::Channel<AgentEvent>) -> bool {
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
                        let output = truncate(&result_text(block.get("content")));
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

// Run a harness turn: spawn the CLI in `cwd`, stream its stdout as agent events, honor cancellation.
#[tauri::command]
pub async fn agent_run(
    harness: String,
    model: String,
    prompt: String,
    cwd: String,
    permission_mode: String,
    stream_id: String,
    on_event: tauri::ipc::Channel<AgentEvent>,
) -> Result<(), String> {
    let cancel = cancel_guard(&stream_id);
    let (program, args) = build_argv(&harness, &prompt, &model, &permission_mode)?;

    let mut child = match spawn(&program, &args, &cwd) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("failed to start '{}': {} (is it installed and on PATH?)", program, e);
            let _ = on_event.send(AgentEvent::Error(msg.clone()));
            return Err(msg);
        }
    };

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    loop {
        if cancel.flag.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.start_kill();
            break;
        }
        match lines.next_line().await {
            Ok(Some(line)) => {
                if handle_line(&line, &on_event) {
                    break;
                }
            }
            Ok(None) => break, // stdout closed → process finishing
            Err(e) => {
                let _ = on_event.send(AgentEvent::Error(e.to_string()));
                break;
            }
        }
    }

    // Surface a nonzero exit (e.g. auth failure) with whatever stderr carried, unless cancelled.
    if !cancel.flag.load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                let mut err = String::new();
                if let Some(se) = child.stderr.take() {
                    let mut r = BufReader::new(se);
                    let _ = r.read_line(&mut err).await;
                }
                let _ = on_event.send(AgentEvent::Error(if err.trim().is_empty() {
                    format!("{} exited with {}", program, status)
                } else {
                    err.trim().to_string()
                }));
            }
        }
    }

    let _ = on_event.send(AgentEvent::Done);
    Ok(())
}
