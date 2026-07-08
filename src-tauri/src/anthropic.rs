// anthropic.rs — Anthropic OAuth token exchange, model listing, and the Messages
// API streaming proxy. All run from Rust to avoid the webview's CORS limits.
use crate::stream::{check_stream_status, http_client, json_or_err, pump_sse, StreamEvent};
use std::ops::ControlFlow;

// Anthropic's OAuth token endpoint sends no CORS headers, so the webview can't
// call it directly — this command performs the exchange/refresh from Rust.
// `body` is the JSON request (authorization_code or refresh_token grant);
// the parsed JSON token response is returned on success.
#[tauri::command]
pub async fn anthropic_oauth_token(body: serde_json::Value) -> Result<serde_json::Value, String> {
    let res = http_client()
        .post("https://console.anthropic.com/v1/oauth/token")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_err(res, "token endpoint").await
}

// List the models available to a key or a connected account (OAuth). Runs from
// Rust because OAuth/subscription requests are rejected from the browser origin.
// Returns the raw /v1/models JSON; the webview maps it to picker entries.
#[tauri::command]
pub async fn anthropic_list_models(token: String, oauth: bool) -> Result<serde_json::Value, String> {
    let mut req = http_client()
        .get("https://api.anthropic.com/v1/models?limit=100")
        .header("anthropic-version", "2023-06-01");
    req = if oauth {
        req.header("authorization", format!("Bearer {}", token))
            .header("anthropic-beta", "oauth-2025-04-20")
    } else {
        req.header("x-api-key", token)
    };

    let res = req.send().await.map_err(|e| e.to_string())?;
    json_or_err(res, "Anthropic").await
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
    stream_id: String,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let cancel = crate::stream::cancel_guard(&stream_id);
    let mut req = http_client()
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

    let res = req.send().await.map_err(|e| e.to_string())?;
    let Some(res) = check_stream_status(res, "Anthropic", &on_event).await else {
        return Ok(());
    };

    // Parse the SSE stream; emit text deltas as they arrive. Usage trickles in across
    // events: input/cache on message_start, output (cumulative) on message_delta.
    // Accumulate and flush a Usage event at stop.
    let (mut input, mut output, mut cache_read, mut cache_write) = (0u64, 0u64, 0u64, 0u64);
    let mut stop_reason: Option<String> = None;
    pump_sse(res, &cancel.flag, |data| {
        let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { return ControlFlow::Continue(()) };
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
                if let Some(r) = j.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                    stop_reason = Some(r.to_string());
                }
            }
            "message_stop" => {
                let _ = on_event.send(StreamEvent::Usage {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read,
                    cache_write,
                    reasoning_tokens: 0, // Anthropic folds thinking into output_tokens.
                    cost: None, // Anthropic bills via token usage; no per-request cost in the response.
                });
                if let Some(r) = stop_reason.take() {
                    let _ = on_event.send(StreamEvent::StopReason(r));
                }
                let _ = on_event.send(StreamEvent::Done);
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
