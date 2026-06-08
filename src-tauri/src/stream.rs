// stream.rs — streaming events sent to the webview + the shared error prefix.

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
