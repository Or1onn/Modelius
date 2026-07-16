// compat.rs — generic OpenAI-compatible endpoints (Ollama, Groq, OpenRouter, …):
// model listing + chat-completions SSE proxy, CORS-free. `provider` is only the error label.
use crate::stream::{check_stream_status, http_client, json_or_err, pump_sse, rate_limit_headers, StreamEvent};
use std::ops::ControlFlow;

fn join_url(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

// GET {base}/models — used to validate an endpoint and list its models.
#[tauri::command]
pub async fn compat_list_models(base_url: String, api_key: String) -> Result<serde_json::Value, String> {
    let mut builder = http_client().get(join_url(&base_url, "/models"));
    if !api_key.is_empty() {
        builder = builder.header("authorization", format!("Bearer {}", api_key));
    }
    let res = builder.send().await.map_err(|e| e.to_string())?;
    json_or_err(res, "Endpoint").await
}

// POST {base}/api/show {"model": name} — Ollama's native model info, incl. the `capabilities`
// array (e.g. ["completion","vision"]). Used to learn whether a local model accepts images.
#[tauri::command]
pub async fn ollama_show(base_url: String, model: String) -> Result<serde_json::Value, String> {
    let res = http_client()
        .post(join_url(&base_url, "/api/show"))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_err(res, "Ollama").await
}

// GET https://openrouter.ai/api/v1/key — the key's spend limit + usage (USD). OpenRouter is the
// only supported provider that exposes an account balance; others have no equivalent endpoint.
#[tauri::command]
pub async fn openrouter_key_status(key: String) -> Result<serde_json::Value, String> {
    let res = http_client()
        .get("https://openrouter.ai/api/v1/key")
        .header("authorization", format!("Bearer {}", key))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_err(res, "OpenRouter").await
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
    let mut builder = http_client()
        .post(join_url(&base_url, "/chat/completions"))
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&body);
    if !api_key.is_empty() {
        builder = builder.header("authorization", format!("Bearer {}", api_key));
    }
    // OpenRouter app-attribution headers (optional, only meaningful on its host).
    if base_url.contains("openrouter.ai") {
        builder = builder
            .header("HTTP-Referer", "https://modelius.app")
            .header("X-Title", "Modelius");
    }

    let res = builder.send().await.map_err(|e| e.to_string())?;
    let Some(res) = check_stream_status(res, &provider, &on_event).await else {
        return Ok(());
    };

    let rl = rate_limit_headers(res.headers());
    if !rl.is_empty() {
        let _ = on_event.send(StreamEvent::RateLimit(rl));
    }

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
        // Image-output models (OpenRouter, Gemini compat): images arrive as data URLs in
        // delta.images (streaming) or message.images (final-chunk shape). Forward as-is.
        for p in ["/choices/0/delta/images", "/choices/0/message/images"] {
            if let Some(arr) = j.pointer(p).and_then(|v| v.as_array()) {
                for im in arr {
                    if let Some(url) = im.pointer("/image_url/url").and_then(|v| v.as_str()) {
                        let _ = on_event.send(StreamEvent::Image(url.to_string()));
                    }
                }
            }
        }
        // finish_reason is null until the final chunk ("stop" / "length" / …).
        if let Some(fr) = j.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()) {
            let _ = on_event.send(StreamEvent::StopReason(fr.to_string()));
        }
        // DeepSeek streams the trace as `reasoning_content`; OpenRouter normalizes it to `reasoning`.
        let think = j
            .pointer("/choices/0/delta/reasoning_content")
            .or_else(|| j.pointer("/choices/0/delta/reasoning"))
            .and_then(|v| v.as_str());
        if let Some(t) = think {
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
                reasoning_tokens: u
                    .pointer("/completion_tokens_details/reasoning_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                // OpenRouter returns the exact billed cost here when the request asks for usage accounting.
                cost: u.get("cost").and_then(|v| v.as_f64()),
            });
        }
        ControlFlow::Continue(())
    })
    .await?;

    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_normalizes_the_base_slash() {
        assert_eq!(join_url("http://x/", "/models"), "http://x/models");
        assert_eq!(join_url("http://x", "/models"), "http://x/models");
    }
}
