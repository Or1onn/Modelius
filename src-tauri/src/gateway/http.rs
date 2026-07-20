// HTTP plumbing shared by every gateway path: the per-connection router, the minimal
// request reader, upstream send + error surfacing, SSE frame reading/writing.
use super::anthropic_openai::proxy_messages;
use super::openai_anthropic::{proxy_chat_to_anthropic, proxy_responses_to_anthropic};
use super::responses::proxy_responses;
use super::{GatewayConfig, Proto};
use crate::stream::http_client;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

// ---- HTTP plumbing (one request per connection, Connection: close) ----

pub(super) async fn handle_conn(mut sock: TcpStream, cfg: &GatewayConfig, token: &str) -> std::io::Result<()> {
    let (method, path, headers, body) = match read_request(&mut sock).await {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };

    if !authorized(&headers, token) {
        return respond_json(&mut sock, 401, &err_body("authentication_error", "invalid gateway token")).await;
    }

    let base = cfg.target_base.trim_end_matches('/');
    match (cfg.inbound, method.as_str(), path.as_str()) {
        (Proto::Anthropic, "POST", "/v1/messages") => match cfg.outbound {
            Proto::OpenAi => proxy_messages(&mut sock, base, &cfg.api_key, &body, &cfg.effort).await,
            Proto::Anthropic => {
                passthrough(&mut sock, "POST", &format!("{}/v1/messages", base), &headers, &body, cfg).await
            }
        },
        (Proto::Anthropic, "POST", "/v1/messages/count_tokens") => match cfg.outbound {
            // Real endpoint upstream — forward; fall back to the estimate if it's missing there.
            Proto::Anthropic => count_tokens_forward(&mut sock, base, &headers, &body, cfg).await,
            // The CLI only needs a ballpark; ~4 chars/token over the serialized request.
            Proto::OpenAi => {
                let est = (body.len() / 4).max(1);
                respond_json(&mut sock, 200, &json!({ "input_tokens": est }).to_string()).await
            }
        },
        (Proto::OpenAi, "POST", "/chat/completions" | "/v1/chat/completions") => match cfg.outbound {
            Proto::OpenAi => {
                passthrough(&mut sock, "POST", &format!("{}/chat/completions", base), &headers, &body, cfg).await
            }
            Proto::Anthropic => proxy_chat_to_anthropic(&mut sock, base, &cfg.api_key, &headers, &body).await,
        },
        // Codex speaks the Responses API; translate it onto the target's chat/completions
        // (openai out) or /v1/messages (anthropic out).
        (Proto::OpenAi, "POST", "/responses" | "/v1/responses") => match cfg.outbound {
            Proto::OpenAi => proxy_responses(&mut sock, base, &cfg.api_key, &body).await,
            Proto::Anthropic => proxy_responses_to_anthropic(&mut sock, base, &cfg.api_key, &headers, &body).await,
        },
        (Proto::OpenAi, "GET", "/models" | "/v1/models") => match cfg.outbound {
            Proto::OpenAi => passthrough(&mut sock, "GET", &format!("{}/models", base), &headers, &[], cfg).await,
            Proto::Anthropic => respond_json(&mut sock, 200, &json!({ "object": "list", "data": [] }).to_string()).await,
        },
        _ => respond_json(&mut sock, 404, &err_body("not_found_error", "unsupported endpoint")).await,
    }
}

// Minimal HTTP/1.1 request reader: request line + headers, then a Content-Length body.
pub(super) async fn read_request(sock: &mut TcpStream) -> std::io::Result<(String, String, Vec<(String, String)>, Vec<u8>)> {
    const MAX_HEAD: usize = 64 * 1024;
    const MAX_BODY: usize = 64 * 1024 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = find_seq(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "headers too large"));
        }
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_ascii_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    // Strip any query string — routing is by path only.
    let path = path.split('?').next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())))
        .collect();

    let content_length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body too large"));
    }

    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < content_length {
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);
    Ok((method, path, headers, body))
}

fn find_seq(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn authorized(headers: &[(String, String)], token: &str) -> bool {
    headers.iter().any(|(k, v)| {
        (k == "authorization" && v.strip_prefix("Bearer ").map(str::trim) == Some(token)) || (k == "x-api-key" && v == token)
    })
}

pub(super) fn err_body(kind: &str, msg: &str) -> String {
    json!({ "type": "error", "error": { "type": kind, "message": msg } }).to_string()
}

pub(super) async fn respond_json(sock: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(body.as_bytes()).await?;
    sock.flush().await
}

// ---- transparent passthrough (same protocol on both sides) ----

// Forward the request verbatim, swapping only the credentials: the inbound Authorization /
// x-api-key carry the loopback token and are replaced with the real provider key. The response
// body is streamed back EOF-delimited (no Content-Length + Connection: close), so SSE tunnels
// through untouched.
// Anthropic credential + version headers. Both credential forms are sent — anthropic-compatible
// gateways vary in which they read; the version echoes the CLI's or defaults.
fn anthropic_auth(
    req: reqwest::RequestBuilder,
    key: &str,
    headers_in: &[(String, String)],
) -> reqwest::RequestBuilder {
    let version = headers_in
        .iter()
        .find(|(k, _)| k == "anthropic-version")
        .map(|(_, v)| v.as_str())
        .unwrap_or("2023-06-01");
    req.header("x-api-key", key)
        .header("authorization", format!("Bearer {}", key))
        .header("anthropic-version", version)
}

async fn passthrough(
    sock: &mut TcpStream,
    method: &str,
    url: &str,
    headers_in: &[(String, String)],
    body: &[u8],
    cfg: &GatewayConfig,
) -> std::io::Result<()> {
    let client = http_client();
    let mut req = if method == "GET" { client.get(url) } else { client.post(url) };

    match cfg.outbound {
        Proto::OpenAi => req = req.bearer_auth(&cfg.api_key),
        Proto::Anthropic => {
            req = anthropic_auth(req, &cfg.api_key, headers_in);
            for (_, v) in headers_in.iter().filter(|(k, _)| k == "anthropic-beta") {
                req = req.header("anthropic-beta", v);
            }
        }
    }
    if method != "GET" {
        let ct = headers_in
            .iter()
            .find(|(k, _)| k == "content-type")
            .map(|(_, v)| v.as_str())
            .unwrap_or("application/json");
        req = req.header("content-type", ct).body(body.to_vec());
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => return respond_json(sock, 502, &err_body("api_error", &format!("upstream unreachable: {}", e))).await,
    };

    let status = upstream.status();
    let ct = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Status"),
        ct
    );
    sock.write_all(head.as_bytes()).await?;
    let mut bytes = upstream.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let Ok(chunk) = chunk else { break };
        sock.write_all(&chunk).await?;
        sock.flush().await?;
    }
    sock.flush().await
}

// count_tokens against an anthropic-compatible upstream: forward buffered; many gateways don't
// implement the endpoint, so any failure falls back to the ~4 chars/token estimate.
async fn count_tokens_forward(
    sock: &mut TcpStream,
    base: &str,
    headers_in: &[(String, String)],
    body: &[u8],
    cfg: &GatewayConfig,
) -> std::io::Result<()> {
    let url = format!("{}/v1/messages/count_tokens", base);
    let upstream = anthropic_auth(http_client().post(&url), &cfg.api_key, headers_in)
        .header("content-type", "application/json")
        .body(body.to_vec())
        .send()
        .await;

    if let Ok(r) = upstream {
        if r.status().is_success() {
            if let Ok(text) = r.text().await {
                return respond_json(sock, 200, &text).await;
            }
        }
    }
    let est = (body.len() / 4).max(1);
    respond_json(sock, 200, &json!({ "input_tokens": est }).to_string()).await
}

// Send a translated request upstream. On transport failure or a non-2xx status the provider's
// own message is written to `sock` (so auth/model errors are readable in the transcript) and
// None is returned.
async fn send_upstream(
    sock: &mut TcpStream,
    req: reqwest::RequestBuilder,
) -> std::io::Result<Option<reqwest::Response>> {
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            respond_json(sock, 502, &err_body("api_error", &format!("upstream unreachable: {}", e))).await?;
            return Ok(None);
        }
    };
    if !upstream.status().is_success() {
        let status = upstream.status().as_u16();
        let text = upstream.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|j| j.pointer("/error/message").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or(text);
        respond_json(sock, status, &err_body("api_error", &msg)).await?;
        return Ok(None);
    }
    Ok(Some(upstream))
}

// POST a translated request to {base}/chat/completions.
pub(super) async fn send_chat(
    sock: &mut TcpStream,
    base: &str,
    key: &str,
    chat_req: &Value,
) -> std::io::Result<Option<reqwest::Response>> {
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    send_upstream(sock, http_client().post(&url).bearer_auth(key).json(chat_req)).await
}

// Read a non-streaming upstream body and answer with the translated response.
pub(super) async fn respond_translated(
    sock: &mut TcpStream,
    upstream: reqwest::Response,
    model: &str,
    translate: fn(&Value, &str) -> Value,
) -> std::io::Result<()> {
    let json: Value = match upstream.json().await {
        Ok(j) => j,
        Err(e) => return respond_json(sock, 502, &err_body("api_error", &format!("bad upstream body: {}", e))).await,
    };
    // Some providers (OpenRouter et al.) return 200 with an error object in the body.
    if let Some(msg) = upstream_error(&json) {
        return respond_json(sock, 502, &err_body("api_error", &msg)).await;
    }
    respond_json(sock, 200, &translate(&json, model).to_string()).await
}

// Borrow a JSON array as a slice ([] when absent or not an array) — avoids the throwaway
// `&Vec::new()` allocation the translators would otherwise pay per call.
pub(super) fn as_slice(v: Option<&Value>) -> &[Value] {
    v.and_then(|v| v.as_array()).map(Vec::as_slice).unwrap_or(&[])
}

// Error object embedded in a 200 body / SSE data line ({"error": {...}} or {"error": "..."}).
pub(super) fn upstream_error(j: &Value) -> Option<String> {
    let e = j.get("error")?;
    if e.is_null() {
        return None;
    }
    Some(
        e.pointer("/message")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| e.to_string()),
    )
}

// POST a translated Messages request to {base}/v1/messages. Mirrors send_chat, one API over.
pub(super) async fn send_messages(
    sock: &mut TcpStream,
    base: &str,
    key: &str,
    headers_in: &[(String, String)],
    msg_req: &Value,
) -> std::io::Result<Option<reqwest::Response>> {
    let url = format!("{}/v1/messages", base.trim_end_matches('/'));
    let req = anthropic_auth(http_client().post(&url), key, headers_in)
        .header("content-type", "application/json")
        .body(msg_req.to_string());
    send_upstream(sock, req).await
}

// Append an upstream chunk to `buf`, split complete SSE lines, and parse each `data:` JSON
// payload. Returns (events, done) — done once a `[DONE]` sentinel is seen (later lines drop).
// Bytes accumulate until a full line is present, so a multibyte character split across chunk
// boundaries survives conversion; consumed bytes are drained once per chunk (a per-line drain
// would memmove the whole remaining buffer for every line).
pub(super) fn drain_sse(buf: &mut Vec<u8>, chunk: &[u8]) -> (Vec<Value>, bool) {
    let mut events = Vec::new();
    buf.extend_from_slice(chunk);
    let mut cursor = 0;
    let mut done = false;
    while let Some(rel) = buf[cursor..].iter().position(|&b| b == b'\n') {
        let pos = cursor + rel;
        let line = String::from_utf8_lossy(&buf[cursor..pos]);
        let data = line.trim_end_matches('\r').strip_prefix("data:").map(str::trim);
        cursor = pos + 1;
        if data == Some("[DONE]") {
            done = true;
            break;
        }
        if let Some(j) = data.and_then(|d| serde_json::from_str::<Value>(d).ok()) {
            events.push(j);
        }
    }
    buf.drain(..cursor);
    (events, done)
}

// SSE frame writer: "event: {name}\ndata: {json}\n\n". With `seq` set (the Responses dialect),
// every event carries an incrementing sequence_number.
pub(super) struct SseWriter<'a> {
    pub(super) sock: &'a mut TcpStream,
    pub(super) seq: Option<u64>,
}

impl<'a> SseWriter<'a> {
    pub(super) async fn event(&mut self, name: &str, mut data: Value) -> std::io::Result<()> {
        if let Some(seq) = self.seq.as_mut() {
            data["sequence_number"] = json!(*seq);
            *seq += 1;
        }
        let frame = format!("event: {}\ndata: {}\n\n", name, data);
        self.sock.write_all(frame.as_bytes()).await
    }
}
