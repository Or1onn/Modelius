// compat.rs — generic OpenAI-compatible endpoints (Ollama, Groq, OpenRouter, …):
// model listing + chat-completions SSE proxy, CORS-free. `provider` is only the error label.
use crate::stream::{check_stream_status, json_or_err, pump_sse, StreamEvent};
use std::ops::ControlFlow;

fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

// GET {base}/models — used to validate an endpoint and list its models.
#[tauri::command]
pub async fn compat_list_models(base_url: String, api_key: String) -> Result<serde_json::Value, String> {
    let mut builder = reqwest::Client::new().get(join_url(&base_url, "/models"));
    if !api_key.is_empty() {
        builder = builder.header("authorization", format!("Bearer {}", api_key));
    }
    let res = builder.send().await.map_err(|e| e.to_string())?;
    json_or_err(res, "Endpoint").await
}

// POST {base}/chat/completions with stream:true; SSE parsed here, deltas over the channel.
#[tauri::command]
pub async fn compat_chat_stream(
    base_url: String,
    api_key: String,
    provider: String,
    body: serde_json::Value,
    stream_id: String,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let cancel = crate::stream::cancel_guard(&stream_id);
    let mut builder = reqwest::Client::new()
        .post(join_url(&base_url, "/chat/completions"))
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&body);
    if !api_key.is_empty() {
        builder = builder.header("authorization", format!("Bearer {}", api_key));
    }

    let res = builder.send().await.map_err(|e| e.to_string())?;
    let Some(res) = check_stream_status(res, &provider, &on_event).await else {
        return Ok(());
    };

    pump_sse(res, &cancel.flag, |data| {
        if data == "[DONE]" {
            let _ = on_event.send(StreamEvent::Done);
            return ControlFlow::Break(());
        }
        let Ok(j) = serde_json::from_str::<serde_json::Value>(data) else { return ControlFlow::Continue(()) };
        if let Some(t) = j.pointer("/choices/0/delta/content").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                let _ = on_event.send(StreamEvent::Chunk(t.to_string()));
            }
        }
        // DeepSeek-style reasoning models stream the trace as `reasoning_content`.
        if let Some(t) = j.pointer("/choices/0/delta/reasoning_content").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                let _ = on_event.send(StreamEvent::Thinking(t.to_string()));
            }
        }
        if let Some(u) = j.get("usage").filter(|u| !u.is_null()) {
            let _ = on_event.send(StreamEvent::Usage {
                input_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                output_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                cache_read: 0,
                cache_write: 0,
            });
        }
        ControlFlow::Continue(())
    })
    .await?;

    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}
