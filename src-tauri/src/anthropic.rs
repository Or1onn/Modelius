// anthropic.rs — Anthropic OAuth token exchange, model listing, and the Messages
// API streaming proxy. All run from Rust to avoid the webview's CORS limits.
use crate::stream::{err_prefix, StreamEvent};

// Anthropic's OAuth token endpoint sends no CORS headers, so the webview can't
// call it directly — this command performs the exchange/refresh from Rust.
// `body` is the JSON request (authorization_code or refresh_token grant);
// the parsed JSON token response is returned on success.
#[tauri::command]
pub async fn anthropic_oauth_token(body: serde_json::Value) -> Result<serde_json::Value, String> {
    let res = reqwest::Client::new()
        .post("https://console.anthropic.com/v1/oauth/token")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("token endpoint {}: {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// List the models available to a key or a connected account (OAuth). Runs from
// Rust because OAuth/subscription requests are rejected from the browser origin.
// Returns the raw /v1/models JSON; the webview maps it to picker entries.
#[tauri::command]
pub async fn anthropic_list_models(token: String, oauth: bool) -> Result<serde_json::Value, String> {
    let mut req = reqwest::Client::new()
        .get("https://api.anthropic.com/v1/models?limit=100")
        .header("anthropic-version", "2023-06-01");
    req = if oauth {
        req.header("authorization", format!("Bearer {}", token))
            .header("anthropic-beta", "oauth-2025-04-20")
    } else {
        req.header("x-api-key", token)
    };

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Anthropic {}: {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

// Proxy the Anthropic Messages API from Rust and stream text deltas back.
// Going through Rust (rather than the webview's fetch) avoids the browser
// origin, which OAuth/subscription accounts reject with a CORS org error.
// `oauth` selects Bearer + the oauth beta header; otherwise an x-api-key.
#[tauri::command]
pub async fn anthropic_messages_stream(
    body: serde_json::Value,
    token: String,
    oauth: bool,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let mut req = reqwest::Client::new()
        .post("https://api.anthropic.com/v1/messages")
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    req = if oauth {
        req.header("authorization", format!("Bearer {}", token))
            .header("anthropic-beta", "oauth-2025-04-20")
    } else {
        req.header("x-api-key", token)
    };

    let mut res = req.send().await.map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        let prefix = err_prefix("Anthropic", status.as_u16(), res.headers());
        let text = res.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error(format!("{}: {}", prefix, text)));
        return Ok(());
    }

    // Parse the SSE stream line-by-line; emit text deltas as they arrive.
    // Usage trickles in across events: input/cache on message_start, output
    // (cumulative) on message_delta. Accumulate and flush a Usage event at stop.
    let mut buf: Vec<u8> = Vec::new();
    let (mut input, mut output, mut cache_read, mut cache_write) = (0u64, 0u64, 0u64, 0u64);
    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            let Some(rest) = line.strip_prefix("data:") else { continue };
            let data = rest.trim();
            if data.is_empty() {
                continue;
            }
            let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            let u64_at = |j: &serde_json::Value, ptr: &str| j.pointer(ptr).and_then(|v| v.as_u64()).unwrap_or(0);
            match j.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "content_block_delta" => {
                    if let Some(text) = j.pointer("/delta/text").and_then(|v| v.as_str()) {
                        let _ = on_event.send(StreamEvent::Chunk(text.to_string()));
                    } else if let Some(t) = j.pointer("/delta/thinking").and_then(|v| v.as_str()) {
                        let _ = on_event.send(StreamEvent::Thinking(t.to_string()));
                    }
                }
                "message_start" => {
                    input = u64_at(&j, "/message/usage/input_tokens");
                    cache_write = u64_at(&j, "/message/usage/cache_creation_input_tokens");
                    cache_read = u64_at(&j, "/message/usage/cache_read_input_tokens");
                }
                "message_delta" => {
                    output = u64_at(&j, "/usage/output_tokens"); // cumulative
                }
                "message_stop" => {
                    let _ = on_event.send(StreamEvent::Usage {
                        input_tokens: input,
                        output_tokens: output,
                        cache_read,
                        cache_write,
                    });
                    let _ = on_event.send(StreamEvent::Done);
                    return Ok(());
                }
                _ => {}
            }
        }
    }

    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}
