// openai.rs — "Sign in with ChatGPT" (Codex OAuth): loopback callback capture,
// token exchange/refresh, and the Responses API streaming proxy.
use crate::stream::{check_stream_status, json_or_err, pump_sse, StreamEvent};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::ops::ControlFlow;
use std::time::{Duration, Instant};

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(path: &str, key: &str) -> Option<String> {
    let q = path.split('?').nth(1)?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            return Some(percent_decode(it.next().unwrap_or("")));
        }
    }
    None
}

const CALLBACK_HTML: &str = "<!doctype html><meta charset=utf-8><title>Orchestro</title>\
<body style=\"font-family:system-ui;background:#0b0b0e;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h2>Signed in to ChatGPT</h2><p style=\"color:#9a9aa2\">You can close this tab and return to Orchestro.</p></div>";

// OpenAI's OAuth redirects to a localhost URL, so we briefly run a loopback
// server to capture the authorization code (validated against `state`).
#[tauri::command]
pub async fn openai_await_callback(state: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener =
            TcpListener::bind("127.0.0.1:1455").map_err(|e| format!("bind localhost:1455 failed: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(300);

        loop {
            if Instant::now() > deadline {
                return Err("Timed out waiting for the OpenAI sign-in to finish.".to_string());
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("");

                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        CALLBACK_HTML.len(),
                        CALLBACK_HTML
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.flush();

                    if let Some(code) = query_param(path, "code") {
                        if query_param(path, "state").as_deref() == Some(state.as_str()) {
                            return Ok(code);
                        }
                        return Err("OAuth state mismatch — please try again.".to_string());
                    }
                    // Ignore unrelated requests (e.g. favicon) and keep waiting.
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// Token exchange / refresh for the OpenAI OAuth flow (form-encoded, no CORS).
#[tauri::command]
pub async fn openai_oauth_token(form: HashMap<String, String>) -> Result<serde_json::Value, String> {
    let res = reqwest::Client::new()
        .post("https://auth.openai.com/oauth/token")
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_err(res, "openai token").await
}

// Stream a completion from the ChatGPT subscription backend (Responses API).
// Runs from Rust to use the OAuth bearer token without browser-origin/CORS limits.
#[tauri::command]
pub async fn openai_responses_stream(
    body: serde_json::Value,
    access_token: String,
    account_id: String,
    stream_id: String,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let cancel = crate::stream::cancel_guard(&stream_id);
    let mut builder = reqwest::Client::new()
        .post("https://chatgpt.com/backend-api/codex/responses")
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .header("authorization", format!("Bearer {}", access_token))
        .header("openai-beta", "responses=experimental")
        .header("originator", "codex_cli_rs")
        .json(&body);
    if !account_id.is_empty() {
        builder = builder.header("chatgpt-account-id", account_id);
    }

    let res = builder.send().await.map_err(|e| e.to_string())?;
    let Some(res) = check_stream_status(res, "ChatGPT", &on_event).await else {
        return Ok(());
    };

    pump_sse(res, &cancel.flag, |data| {
        if data == "[DONE]" {
            return ControlFlow::Continue(());
        }
        let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { return ControlFlow::Continue(()) };
        match j.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "response.output_text.delta" => {
                if let Some(t) = j.get("delta").and_then(|v| v.as_str()) {
                    let _ = on_event.send(StreamEvent::Chunk(t.to_string()));
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(t) = j.get("delta").and_then(|v| v.as_str()) {
                    let _ = on_event.send(StreamEvent::Thinking(t.to_string()));
                }
            }
            "response.completed" => {
                let _ = on_event.send(StreamEvent::Usage {
                    input_tokens: j.pointer("/response/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    output_tokens: j.pointer("/response/usage/output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    cache_read: 0,
                    cache_write: 0,
                    reasoning_tokens: j
                        .pointer("/response/usage/output_tokens_details/reasoning_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cost: None, // OpenAI bills via token usage; no per-request cost in the response.
                });
                let _ = on_event.send(StreamEvent::Done);
                return ControlFlow::Break(());
            }
            "response.failed" | "error" => {
                let msg = j
                    .pointer("/response/error/message")
                    .and_then(|v| v.as_str())
                    .or_else(|| j.get("message").and_then(|v| v.as_str()))
                    .unwrap_or("response failed");
                let _ = on_event.send(StreamEvent::Error(msg.to_string()));
                return ControlFlow::Break(());
            }
            _ => {}
        }
        ControlFlow::Continue(())
    })
    .await?;

    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}
