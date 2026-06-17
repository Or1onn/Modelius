// stream.rs — streaming events sent to the webview + shared streaming/error helpers.
use reqwest::Response;
use std::ops::ControlFlow;

// Streaming events sent back to the webview over a Tauri channel.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum StreamEvent {
    Chunk(String),
    Thinking(String),
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read: u64,
        cache_write: u64,
    },
    Done,
    Error(String),
}

// Build a "Provider STATUS [(retry-after: Ns)]" error prefix. Only a numeric
// retry-after (seconds) is appended; the webview parses it for friendly text.
pub(crate) fn err_prefix(provider: &str, status: u16, headers: &reqwest::header::HeaderMap) -> String {
    let retry = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    match retry {
        Some(secs) => format!("{} {} (retry-after: {}s)", provider, status, secs),
        None => format!("{} {}", provider, status),
    }
}

// Pass the response through on 2xx; otherwise emit a Provider-prefixed Error event and return None.
pub(crate) async fn check_stream_status(
    res: Response,
    provider: &str,
    on_event: &tauri::ipc::Channel<StreamEvent>,
) -> Option<Response> {
    let status = res.status();
    if status.is_success() {
        return Some(res);
    }
    let prefix = err_prefix(provider, status.as_u16(), res.headers());
    let text = res.text().await.unwrap_or_default();
    let _ = on_event.send(StreamEvent::Error(format!("{}: {}", prefix, text)));
    None
}

// Read an SSE body line-by-line, handing each non-empty `data:` payload to `on_data`.
// `on_data` returns ControlFlow::Break to stop early (e.g. on [DONE] / completion events).
pub(crate) async fn pump_sse<F>(mut res: Response, mut on_data: F) -> Result<(), String>
where
    F: FnMut(&str) -> ControlFlow<()>,
{
    let mut buf: Vec<u8> = Vec::new();
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
            if on_data(data).is_break() {
                return Ok(());
            }
        }
    }
    Ok(())
}

// Read a non-streaming JSON response: parse on 2xx, else "<label> <status>: <body>" (body capped).
pub(crate) async fn json_or_err(res: Response, label: &str) -> Result<serde_json::Value, String> {
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let body: String = text.chars().take(300).collect();
        return Err(format!("{} {}: {}", label, status.as_u16(), body));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
