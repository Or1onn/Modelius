// stream.rs — streaming events sent to the webview + shared streaming/error helpers.
use reqwest::Response;
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// One shared upstream client: reuses pooled TLS connections across the many sequential calls a
// chat session makes. A per-request Client::new() would pay DNS + TCP + TLS handshake every time.
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

// Cancellation registry: maps a per-request stream id to a flag the pump loop polls.
// The webview flips it via `cancel_stream` when the user hits Stop, so the proxy drops
// the upstream connection instead of streaming a response nobody is reading.
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

// RAII handle: registers a cancel flag for `id` and removes it on drop (every command exit path).
pub(crate) struct CancelGuard {
    id: String,
    pub flag: Arc<AtomicBool>,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        cancels().lock().unwrap().remove(&self.id);
    }
}

pub(crate) fn cancel_guard(id: &str) -> CancelGuard {
    let flag = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(id.to_string(), flag.clone());
    CancelGuard { id: id.to_string(), flag }
}

// Flip the flag for a live stream so its pump loop stops at the next chunk boundary.
#[tauri::command]
pub fn cancel_stream(stream_id: String) {
    if let Some(flag) = cancels().lock().unwrap().get(&stream_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

// Streaming events sent back to the webview over a Tauri channel.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum StreamEvent {
    Chunk(String),
    Thinking(String),
    // A model-generated image as a complete data URL (image-output chat models).
    Image(String),
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cache_read: u64,
        cache_write: u64,
        // Reasoning/thinking tokens billed on top of the visible answer (OpenRouter reports them
        // separately under completion_tokens_details); 0 when the upstream doesn't break them out.
        reasoning_tokens: u64,
        // Exact billed cost (USD) when the upstream API reports it (OpenRouter); else None.
        cost: Option<f64>,
    },
    // Why the model stopped ("max_tokens" / "length" / "max_output_tokens" / "end_turn" / "stop").
    // The webview offers "Continue" when this signals a max-output-tokens cutoff.
    StopReason(String),
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
// Returns at the next chunk boundary once `cancel` is set — dropping `res` closes the connection.
pub(crate) async fn pump_sse<F>(mut res: Response, cancel: &AtomicBool, mut on_data: F) -> Result<(), String>
where
    F: FnMut(&str) -> ControlFlow<()>,
{
    let mut buf: Vec<u8> = Vec::new();
    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            // Parse the line in place, then drain it — avoids a Vec allocation per SSE line.
            let line = String::from_utf8_lossy(&buf[..pos]);
            let data = line.trim().strip_prefix("data:").map(str::trim).unwrap_or("");
            let brk = !data.is_empty() && on_data(data).is_break();
            buf.drain(..=pos);
            if brk {
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
