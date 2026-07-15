// gateway.rs — a per-run local HTTP proxy that lets any agentic CLI harness drive any model
// endpoint. It accepts the protocol the CLI speaks (`inbound`) on 127.0.0.1:<random port> and
// forwards to the target endpoint's protocol (`outbound`):
//
//   inbound   outbound   handling
//   anthropic openai     translate Messages API ⇄ chat/completions (streaming SSE included)
//   anthropic anthropic  transparent passthrough
//   openai    openai     transparent passthrough
//   openai    anthropic  501 (translation not implemented yet)
//
// Security: the listener binds loopback only; every request must carry the per-run random
// token (Authorization: Bearer / x-api-key), so other local processes can't relay through
// the stored provider key. The provider key itself never reaches the CLI process.
use crate::stream::http_client;
use futures_util::StreamExt;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Copy)]
pub(crate) enum Proto {
    Anthropic,
    OpenAi,
}

pub(crate) struct GatewayConfig {
    pub inbound: Proto,      // protocol the CLI speaks
    pub outbound: Proto,     // protocol the target endpoint speaks
    pub target_base: String, // provider root, no trailing slash
    pub api_key: String,     // real provider key; never reaches the CLI
}

pub(crate) struct Gateway {
    pub port: u16,
    pub token: String,
    handle: tokio::task::JoinHandle<()>,
}

impl Gateway {
    pub fn shutdown(&self) {
        self.handle.abort();
    }
}

// Start the proxy. Returns the bound port + minted client token.
pub(crate) async fn start(cfg: GatewayConfig) -> std::io::Result<Gateway> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut raw = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut raw);
    let token: String = raw.iter().map(|b| format!("{:02x}", b)).collect();

    let tok = token.clone();
    let cfg = std::sync::Arc::new(cfg);
    let handle = tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { break };
            // SSE deltas are many small writes — without nodelay, Nagle stalls each one waiting
            // for the previous ACK and streaming visibly drips.
            let _ = sock.set_nodelay(true);
            let (cfg, tok) = (cfg.clone(), tok.clone());
            tokio::spawn(async move {
                let _ = handle_conn(sock, &cfg, &tok).await;
            });
        }
    });
    Ok(Gateway { port, token, handle })
}

// ---- HTTP plumbing (one request per connection, Connection: close) ----

async fn handle_conn(mut sock: TcpStream, cfg: &GatewayConfig, token: &str) -> std::io::Result<()> {
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
            Proto::OpenAi => proxy_messages(&mut sock, base, &cfg.api_key, &body).await,
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
async fn read_request(sock: &mut TcpStream) -> std::io::Result<(String, String, Vec<(String, String)>, Vec<u8>)> {
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

fn err_body(kind: &str, msg: &str) -> String {
    json!({ "type": "error", "error": { "type": kind, "message": msg } }).to_string()
}

async fn respond_json(sock: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        501 => "Not Implemented",
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

// POST a translated request to {base}/chat/completions. On transport failure or a non-2xx
// status the error is written to `sock` (surfacing the provider's own message so auth/model
// errors are readable in the transcript) and None is returned.
async fn send_chat(
    sock: &mut TcpStream,
    base: &str,
    key: &str,
    chat_req: &Value,
) -> std::io::Result<Option<reqwest::Response>> {
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let upstream = http_client().post(&url).bearer_auth(key).json(chat_req).send().await;
    let upstream = match upstream {
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

// Read a non-streaming upstream body and answer with the translated response.
async fn respond_translated(
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

// ---- /v1/messages: translate and forward (anthropic-in → openai-out) ----

async fn proxy_messages(sock: &mut TcpStream, base: &str, key: &str, body: &[u8]) -> std::io::Result<()> {
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        return respond_json(sock, 400, &err_body("invalid_request_error", "bad JSON")).await;
    };
    let stream = req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let model = req.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let openai_req = to_openai_request(&req, base, stream);

    let Some(upstream) = send_chat(sock, base, key, &openai_req).await? else {
        return Ok(());
    };
    if stream {
        stream_response(sock, upstream, &model).await
    } else {
        respond_translated(sock, upstream, &model, to_anthropic_response).await
    }
}

// Shared chat/completions request tail: token cap (api.openai.com rejects max_tokens on current
// models; compat providers expect it) + streaming usage accounting.
fn apply_chat_common(out: &mut Value, req: &Value, max_key: &str, base: &str, stream: bool) {
    if let Some(mt) = req.get(max_key) {
        let field = if base.contains("api.openai.com") { "max_completion_tokens" } else { "max_tokens" };
        out[field] = mt.clone();
    }
    if stream {
        out["stream"] = json!(true);
        out["stream_options"] = json!({ "include_usage": true });
    }
}

// Map tool entries to the chat/completions nested {type:"function", function:{…}} shape.
// `params_key` names where the source schema lives; `filter` skips non-function entries.
fn map_chat_tools(tools: &[Value], params_key: &str, filter: fn(&Value) -> bool) -> Option<Value> {
    let mapped: Vec<Value> = tools
        .iter()
        .filter(|t| filter(t))
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.get("name").cloned().unwrap_or(Value::Null),
                    "description": t.get("description").cloned().unwrap_or(Value::Null),
                    "parameters": t.get(params_key).cloned().unwrap_or(json!({ "type": "object" })),
                },
            })
        })
        .collect();
    (!mapped.is_empty()).then_some(Value::Array(mapped))
}

// Error object embedded in a 200 body / SSE data line ({"error": {...}} or {"error": "..."}).
fn upstream_error(j: &Value) -> Option<String> {
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

// Anthropic Messages request → OpenAI chat/completions request.
fn to_openai_request(req: &Value, base: &str, stream: bool) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // system: string or [{type:"text"}] blocks.
    match req.get("system") {
        Some(Value::String(s)) if !s.is_empty() => messages.push(json!({ "role": "system", "content": s })),
        Some(Value::Array(blocks)) => {
            let text = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n\n");
            if !text.is_empty() {
                messages.push(json!({ "role": "system", "content": text }));
            }
        }
        _ => {}
    }

    for m in req.get("messages").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        match m.get("content") {
            Some(Value::String(s)) => messages.push(json!({ "role": role, "content": s })),
            Some(Value::Array(blocks)) => {
                if role == "assistant" {
                    let mut text = String::new();
                    let mut tool_calls: Vec<Value> = Vec::new();
                    for b in blocks {
                        match b.get("type").and_then(|v| v.as_str()) {
                            Some("text") => text.push_str(b.get("text").and_then(|v| v.as_str()).unwrap_or("")),
                            Some("tool_use") => tool_calls.push(json!({
                                "id": b.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                                "type": "function",
                                "function": {
                                    "name": b.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                    "arguments": b.get("input").map(|i| i.to_string()).unwrap_or_else(|| "{}".into()),
                                },
                            })),
                            _ => {} // thinking et al. — drop
                        }
                    }
                    let mut msg = json!({ "role": "assistant" });
                    msg["content"] = if text.is_empty() { Value::Null } else { Value::String(text) };
                    if !tool_calls.is_empty() {
                        msg["tool_calls"] = Value::Array(tool_calls);
                    }
                    messages.push(msg);
                } else {
                    // User turn: tool_result blocks become role:"tool" messages (must precede the
                    // user content); text/image blocks become one user message.
                    let mut parts: Vec<Value> = Vec::new();
                    for b in blocks {
                        match b.get("type").and_then(|v| v.as_str()) {
                            Some("tool_result") => messages.push(json!({
                                "role": "tool",
                                "tool_call_id": b.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or(""),
                                "content": tool_result_text(b.get("content")),
                            })),
                            Some("text") => parts.push(json!({ "type": "text", "text": b.get("text").and_then(|v| v.as_str()).unwrap_or("") })),
                            Some("image") => {
                                if let (Some(mt), Some(data)) = (
                                    b.pointer("/source/media_type").and_then(|v| v.as_str()),
                                    b.pointer("/source/data").and_then(|v| v.as_str()),
                                ) {
                                    parts.push(json!({ "type": "image_url", "image_url": { "url": format!("data:{};base64,{}", mt, data) } }));
                                }
                            }
                            _ => {}
                        }
                    }
                    if parts.len() == 1 && parts[0].get("type").and_then(|v| v.as_str()) == Some("text") {
                        messages.push(json!({ "role": "user", "content": parts[0]["text"] }));
                    } else if !parts.is_empty() {
                        messages.push(json!({ "role": "user", "content": parts }));
                    }
                }
            }
            _ => {}
        }
    }

    let mut out = json!({
        "model": req.get("model").cloned().unwrap_or(Value::Null),
        "messages": messages,
    });

    apply_chat_common(&mut out, req, "max_tokens", base, stream);
    if let Some(stops) = req.get("stop_sequences") {
        out["stop"] = stops.clone();
    }
    // OpenRouter surfaces reasoning only when asked (mirrors chat mode's OpenRouter-only extra);
    // other compat providers may reject the unknown field, so keep it host-gated.
    if base.contains("openrouter.ai") && req.pointer("/thinking/type").and_then(|v| v.as_str()) == Some("enabled") {
        out["reasoning"] = match req.pointer("/thinking/budget_tokens").and_then(|v| v.as_u64()) {
            Some(budget) => json!({ "max_tokens": budget }),
            None => json!({ "enabled": true }),
        };
    }
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()) {
        // Skip server-tool entries with no schema.
        if let Some(mapped) = map_chat_tools(tools, "input_schema", |t| t.get("name").is_some()) {
            out["tools"] = mapped;
        }
    }
    match req.pointer("/tool_choice/type").and_then(|v| v.as_str()) {
        Some("any") => out["tool_choice"] = json!("required"),
        Some("tool") => {
            if let Some(name) = req.pointer("/tool_choice/name") {
                out["tool_choice"] = json!({ "type": "function", "function": { "name": name } });
            }
        }
        _ => {}
    }
    out
}

pub(crate) fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn map_stop(finish: Option<&str>) -> &'static str {
    match finish {
        Some("tool_calls") => "tool_use",
        Some("length") => "max_tokens",
        _ => "end_turn",
    }
}

// Reasoning delta/field from an OpenAI-compatible payload (DeepSeek streams `reasoning_content`;
// OpenRouter normalizes it to `reasoning`).
fn reasoning_text(v: &Value) -> Option<&str> {
    v.get("reasoning_content")
        .or_else(|| v.get("reasoning"))
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
}

// OpenAI non-stream response → Anthropic Messages response.
fn to_anthropic_response(j: &Value, model: &str) -> Value {
    let mut content: Vec<Value> = Vec::new();
    let msg = j.pointer("/choices/0/message");
    if let Some(r) = msg.and_then(reasoning_text) {
        content.push(json!({ "type": "thinking", "thinking": r, "signature": "" }));
    }
    if let Some(text) = msg.and_then(|m| m.get("content")).and_then(|v| v.as_str()) {
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
    }
    for tc in msg.and_then(|m| m.get("tool_calls")).and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
        let args = tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}");
        content.push(json!({
            "type": "tool_use",
            "id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "name": tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or(""),
            "input": serde_json::from_str::<Value>(args).unwrap_or(json!({})),
        }));
    }
    let finish = j.pointer("/choices/0/finish_reason").and_then(|v| v.as_str());
    json!({
        "id": j.get("id").and_then(|v| v.as_str()).unwrap_or("msg_gateway"),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": map_stop(finish),
        "stop_sequence": null,
        "usage": {
            "input_tokens": j.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            "output_tokens": j.pointer("/usage/completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        },
    })
}

// Append an upstream chunk to `buf`, drain complete SSE lines, and parse each `data:` JSON
// payload. Returns (events, done) — done once a `[DONE]` sentinel is seen (later lines drop).
// Parses slices in place before draining, so no per-line String allocation.
fn drain_sse(buf: &mut String, chunk: &[u8]) -> (Vec<Value>, bool) {
    let mut events = Vec::new();
    buf.push_str(&String::from_utf8_lossy(chunk));
    while let Some(nl) = buf.find('\n') {
        let data = buf[..nl].trim_end_matches('\r').strip_prefix("data:").map(str::trim);
        let done = data == Some("[DONE]");
        if !done {
            if let Some(j) = data.and_then(|d| serde_json::from_str::<Value>(d).ok()) {
                events.push(j);
            }
        }
        buf.drain(..nl + 1);
        if done {
            return (events, true);
        }
    }
    (events, false)
}

// ---- streaming translation (OpenAI SSE chunks → Anthropic SSE events) ----

struct SseWriter<'a> {
    sock: &'a mut TcpStream,
}

impl<'a> SseWriter<'a> {
    async fn event(&mut self, name: &str, data: &Value) -> std::io::Result<()> {
        let frame = format!("event: {}\ndata: {}\n\n", name, data);
        self.sock.write_all(frame.as_bytes()).await
    }
}

async fn stream_response(sock: &mut TcpStream, upstream: reqwest::Response, model: &str) -> std::io::Result<()> {
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
    )
    .await?;

    let mut w = SseWriter { sock };
    w.event(
        "message_start",
        &json!({
            "type": "message_start",
            "message": {
                "id": "msg_gateway", "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": { "input_tokens": 0, "output_tokens": 0 },
            },
        }),
    )
    .await?;

    // Block bookkeeping: at most one open block at a time (thinking, text, or the current tool call).
    #[derive(Clone, Copy, PartialEq)]
    enum Blk {
        Think,
        Text,
        Tool,
    }
    let mut next_index: u64 = 0;
    let mut open: Option<(u64, Blk)> = None;
    let mut tool_blocks: std::collections::HashMap<u64, u64> = std::collections::HashMap::new(); // openai tc index → block index
    let mut finish: Option<String> = None;
    let mut usage: (u64, u64) = (0, 0);

    let mut buf = String::new();
    let mut bytes = upstream.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let Ok(chunk) = chunk else { break };
        let (events, done) = drain_sse(&mut buf, &chunk);
        for j in events {

            // Mid-stream error (OpenRouter and friends send 200 + {"error": …} in the stream,
            // e.g. rate limits or "model does not support tool use"). Swallowing it would hand
            // the CLI an empty message and send its agent loop into endless retries — surface
            // it as an Anthropic SSE error event so the CLI aborts with a readable message.
            if let Some(msg) = upstream_error(&j) {
                if let Some((idx, _)) = open.take() {
                    w.event("content_block_stop", &json!({ "type": "content_block_stop", "index": idx })).await?;
                }
                w.event("error", &json!({ "type": "error", "error": { "type": "api_error", "message": msg } })).await?;
                return w.sock.flush().await;
            }

            if let Some(u) = j.get("usage").filter(|u| !u.is_null()) {
                usage = (
                    u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.0),
                    u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.1),
                );
            }
            if let Some(f) = j.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()) {
                finish = Some(f.to_string());
            }
            let Some(delta) = j.pointer("/choices/0/delta") else { continue };

            // Reasoning delta → ensure a thinking block is open.
            if let Some(t) = reasoning_text(delta) {
                if let Some((idx, k)) = open {
                    if k != Blk::Think {
                        w.event("content_block_stop", &json!({ "type": "content_block_stop", "index": idx })).await?;
                        open = None;
                    }
                }
                if open.is_none() {
                    w.event(
                        "content_block_start",
                        &json!({ "type": "content_block_start", "index": next_index, "content_block": { "type": "thinking", "thinking": "" } }),
                    )
                    .await?;
                    open = Some((next_index, Blk::Think));
                    next_index += 1;
                }
                let idx = open.unwrap().0;
                w.event(
                    "content_block_delta",
                    &json!({ "type": "content_block_delta", "index": idx, "delta": { "type": "thinking_delta", "thinking": t } }),
                )
                .await?;
            }

            // Text delta → ensure a text block is open.
            if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    if let Some((idx, k)) = open {
                        if k != Blk::Text {
                            w.event("content_block_stop", &json!({ "type": "content_block_stop", "index": idx })).await?;
                            open = None;
                        }
                    }
                    if open.is_none() {
                        w.event(
                            "content_block_start",
                            &json!({ "type": "content_block_start", "index": next_index, "content_block": { "type": "text", "text": "" } }),
                        )
                        .await?;
                        open = Some((next_index, Blk::Text));
                        next_index += 1;
                    }
                    let idx = open.unwrap().0;
                    w.event(
                        "content_block_delta",
                        &json!({ "type": "content_block_delta", "index": idx, "delta": { "type": "text_delta", "text": text } }),
                    )
                    .await?;
                }
            }

            // Tool-call deltas: a new id/name opens a tool_use block; argument fragments stream as input_json_delta.
            for tc in delta.get("tool_calls").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
                let tc_index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                if !tool_blocks.contains_key(&tc_index) {
                    if let Some((idx, _)) = open {
                        w.event("content_block_stop", &json!({ "type": "content_block_stop", "index": idx })).await?;
                    }
                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("call_gateway");
                    let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("");
                    w.event(
                        "content_block_start",
                        &json!({
                            "type": "content_block_start", "index": next_index,
                            "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
                        }),
                    )
                    .await?;
                    tool_blocks.insert(tc_index, next_index);
                    open = Some((next_index, Blk::Tool));
                    next_index += 1;
                }
                if let Some(args) = tc.pointer("/function/arguments").and_then(|v| v.as_str()) {
                    if !args.is_empty() {
                        let idx = tool_blocks[&tc_index];
                        w.event(
                            "content_block_delta",
                            &json!({ "type": "content_block_delta", "index": idx, "delta": { "type": "input_json_delta", "partial_json": args } }),
                        )
                        .await?;
                    }
                }
            }
        }
        if done {
            break;
        }
    }

    if let Some((idx, _)) = open {
        w.event("content_block_stop", &json!({ "type": "content_block_stop", "index": idx })).await?;
    }
    // Upstream produced nothing at all (no content, no finish reason) — an empty assistant
    // message would make the CLI retry forever, so fail the request loudly instead.
    if next_index == 0 && finish.is_none() {
        w.event(
            "error",
            &json!({ "type": "error", "error": { "type": "api_error", "message": "upstream returned an empty response" } }),
        )
        .await?;
        return w.sock.flush().await;
    }
    w.event(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": map_stop(finish.as_deref()), "stop_sequence": null },
            "usage": { "input_tokens": usage.0, "output_tokens": usage.1 },
        }),
    )
    .await?;
    w.event("message_stop", &json!({ "type": "message_stop" })).await?;
    w.sock.flush().await
}

// ---- /responses: translate the OpenAI Responses API ⇄ chat/completions ----
//
// Codex only speaks the Responses API. We forward its requests onto the target endpoint's
// chat/completions (the protocol every bound provider serves) and translate the answer back into
// Responses events / objects. Mirrors the anthropic path above, one API shape over.

async fn proxy_responses(sock: &mut TcpStream, base: &str, key: &str, body: &[u8]) -> std::io::Result<()> {
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        return respond_json(sock, 400, &err_body("invalid_request_error", "bad JSON")).await;
    };
    let stream = req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let model = req.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let chat_req = responses_to_chat(&req, base, stream);

    let Some(upstream) = send_chat(sock, base, key, &chat_req).await? else {
        return Ok(());
    };
    if stream {
        stream_responses(sock, upstream, &model).await
    } else {
        respond_translated(sock, upstream, &model, chat_to_responses).await
    }
}

// Responses request → OpenAI chat/completions request.
fn responses_to_chat(req: &Value, base: &str, stream: bool) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // `instructions` is the Responses system prompt.
    if let Some(s) = req.get("instructions").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            messages.push(json!({ "role": "system", "content": s }));
        }
    }

    match req.get("input") {
        Some(Value::String(s)) => messages.push(json!({ "role": "user", "content": s })),
        Some(Value::Array(items)) => {
            for it in items {
                match it.get("type").and_then(|v| v.as_str()) {
                    // A conversational message: content is a string or an array of typed parts.
                    Some("message") | None => {
                        let role = it.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                        match it.get("content") {
                            Some(Value::String(s)) => messages.push(json!({ "role": role, "content": s })),
                            Some(Value::Array(parts)) => {
                                let mut chat_parts: Vec<Value> = Vec::new();
                                for p in parts {
                                    match p.get("type").and_then(|v| v.as_str()) {
                                        Some("input_text") | Some("output_text") | Some("text") => chat_parts
                                            .push(json!({ "type": "text", "text": p.get("text").and_then(|v| v.as_str()).unwrap_or("") })),
                                        Some("input_image") => {
                                            if let Some(url) = p.get("image_url").and_then(|v| v.as_str()) {
                                                chat_parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                if chat_parts.len() == 1 && chat_parts[0].get("type").and_then(|v| v.as_str()) == Some("text") {
                                    messages.push(json!({ "role": role, "content": chat_parts[0]["text"] }));
                                } else if !chat_parts.is_empty() {
                                    messages.push(json!({ "role": role, "content": chat_parts }));
                                }
                            }
                            _ => {}
                        }
                    }
                    // A prior tool call the model made.
                    Some("function_call") => {
                        let call_id = it.get("call_id").or_else(|| it.get("id")).and_then(|v| v.as_str()).unwrap_or("");
                        let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let arguments = it.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                        messages.push(json!({
                            "role": "assistant",
                            "content": Value::Null,
                            "tool_calls": [{ "id": call_id, "type": "function", "function": { "name": name, "arguments": arguments } }],
                        }));
                    }
                    // The result the harness fed back for a prior tool call.
                    Some("function_call_output") => {
                        let call_id = it.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
                        let output = match it.get("output") {
                            Some(Value::String(s)) => s.clone(),
                            Some(v) => v.to_string(),
                            None => String::new(),
                        };
                        messages.push(json!({ "role": "tool", "tool_call_id": call_id, "content": output }));
                    }
                    _ => {} // reasoning items et al. — drop
                }
            }
        }
        _ => {}
    }

    let mut out = json!({
        "model": req.get("model").cloned().unwrap_or(Value::Null),
        "messages": messages,
    });

    apply_chat_common(&mut out, req, "max_output_tokens", base, stream);
    // Responses tools are flat ({type, name, description, parameters}); chat nests under "function".
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()) {
        let is_fn = |t: &Value| t.get("type").and_then(|v| v.as_str()) == Some("function") && t.get("name").is_some();
        if let Some(mapped) = map_chat_tools(tools, "parameters", is_fn) {
            out["tools"] = mapped;
        }
    }
    match req.get("tool_choice") {
        Some(Value::String(s)) => out["tool_choice"] = json!(s),
        Some(Value::Object(_)) => {
            if let Some(name) = req.pointer("/tool_choice/name") {
                out["tool_choice"] = json!({ "type": "function", "function": { "name": name } });
            }
        }
        _ => {}
    }
    if let Some(p) = req.get("parallel_tool_calls") {
        out["parallel_tool_calls"] = p.clone();
    }
    // OpenRouter surfaces reasoning only when asked — carry over Codex's requested effort
    // (host-gated: other compat providers may reject the unknown field).
    if base.contains("openrouter.ai") {
        if let Some(e) = req.pointer("/reasoning/effort").and_then(|v| v.as_str()) {
            // Codex efforts beyond OpenRouter's low/medium/high clamp to the nearest.
            let e = match e {
                "minimal" | "none" => "low",
                "xhigh" => "high",
                other => other,
            };
            out["reasoning"] = json!({ "effort": e });
        }
    }
    out
}

// OpenAI non-stream chat response → Responses response object.
fn chat_to_responses(j: &Value, model: &str) -> Value {
    let mut output: Vec<Value> = Vec::new();
    let msg = j.pointer("/choices/0/message");
    if let Some(r) = msg.and_then(reasoning_text) {
        output.push(json!({
            "type": "reasoning", "id": "rs_0",
            "summary": [{ "type": "summary_text", "text": r }],
        }));
    }
    if let Some(text) = msg.and_then(|m| m.get("content")).and_then(|v| v.as_str()) {
        if !text.is_empty() {
            output.push(json!({
                "type": "message", "id": "msg_gateway", "role": "assistant", "status": "completed",
                "content": [{ "type": "output_text", "text": text, "annotations": [] }],
            }));
        }
    }
    for (i, tc) in msg.and_then(|m| m.get("tool_calls")).and_then(|v| v.as_array()).unwrap_or(&Vec::new()).iter().enumerate() {
        output.push(json!({
            "type": "function_call",
            "id": format!("fc_{}", i),
            "call_id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "name": tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or(""),
            "arguments": tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}"),
            "status": "completed",
        }));
    }
    json!({
        "id": "resp_gateway", "object": "response", "status": "completed", "model": model,
        "output": output,
        "usage": {
            "input_tokens": j.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            "output_tokens": j.pointer("/usage/completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            "total_tokens": j.pointer("/usage/total_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        },
    })
}

// A Responses SSE writer: every event carries an incrementing sequence_number.
struct RespWriter<'a> {
    sock: &'a mut TcpStream,
    seq: u64,
}

impl<'a> RespWriter<'a> {
    async fn event(&mut self, name: &str, mut data: Value) -> std::io::Result<()> {
        data["sequence_number"] = json!(self.seq);
        self.seq += 1;
        let frame = format!("event: {}\ndata: {}\n\n", name, data);
        self.sock.write_all(frame.as_bytes()).await
    }
}

// Flush accumulated upstream reasoning as one completed Responses reasoning item (summary_text).
// Called when the model moves on to text/tool output (and at stream end), so codex sees the
// reasoning item before whatever follows it.
async fn flush_reasoning(
    w: &mut RespWriter<'_>,
    buf: &mut String,
    output_index: &mut u64,
    done: &mut Vec<(u64, Value)>,
) -> std::io::Result<()> {
    if buf.is_empty() {
        return Ok(());
    }
    let oi = *output_index;
    *output_index += 1;
    let id = format!("rs_{}", oi);
    w.event(
        "response.output_item.added",
        json!({ "type": "response.output_item.added", "output_index": oi,
            "item": { "type": "reasoning", "id": id, "summary": [] } }),
    )
    .await?;
    let item = json!({ "type": "reasoning", "id": id,
        "summary": [{ "type": "summary_text", "text": std::mem::take(buf) }] });
    w.event(
        "response.output_item.done",
        json!({ "type": "response.output_item.done", "output_index": oi, "item": item.clone() }),
    )
    .await?;
    done.push((oi, item));
    Ok(())
}

// A function-call item accumulated across streamed argument fragments.
struct RespToolAcc {
    output_index: u64,
    item_id: String,
    call_id: String,
    name: String,
    args: String,
}

// ---- streaming translation (OpenAI SSE chunks → Responses SSE events) ----
async fn stream_responses(sock: &mut TcpStream, upstream: reqwest::Response, model: &str) -> std::io::Result<()> {
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
    )
    .await?;

    let mut w = RespWriter { sock, seq: 0 };
    w.event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": "resp_gateway", "object": "response", "status": "in_progress", "model": model, "output": [] } }),
    )
    .await?;

    let mut output_index: u64 = 0;
    // Text (assistant message) block.
    let mut text_open = false;
    let text_item_id = "msg_0";
    let mut text_oi: u64 = 0;
    let mut text_buf = String::new();
    // Tool-call blocks, keyed by the upstream tool_call index; `tool_order` preserves emit order.
    let mut tools: std::collections::HashMap<u64, RespToolAcc> = std::collections::HashMap::new();
    let mut tool_order: Vec<u64> = Vec::new();
    let mut usage: (u64, u64, u64) = (0, 0, 0);
    // Upstream reasoning, buffered until the model moves on to text/tools (see flush_reasoning).
    let mut think_buf = String::new();
    let mut think_items: Vec<(u64, Value)> = Vec::new();

    let mut buf = String::new();
    let mut bytes = upstream.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let Ok(chunk) = chunk else { break };
        let (events, done) = drain_sse(&mut buf, &chunk);
        for j in events {

            // Mid-stream error (200 + {"error": …}) → surface as response.failed so Codex aborts
            // with a readable message instead of retrying an empty turn forever.
            if let Some(msg) = upstream_error(&j) {
                w.event(
                    "response.failed",
                    json!({ "type": "response.failed", "response": { "id": "resp_gateway", "status": "failed", "error": { "message": msg } } }),
                )
                .await?;
                return w.sock.flush().await;
            }

            if let Some(u) = j.get("usage").filter(|u| !u.is_null()) {
                usage = (
                    u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.0),
                    u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.1),
                    u.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.2),
                );
            }
            let Some(delta) = j.pointer("/choices/0/delta") else { continue };

            // Reasoning delta → buffer; emitted as one reasoning item on the next text/tool.
            if let Some(t) = reasoning_text(delta) {
                think_buf.push_str(t);
            }

            // Text delta → ensure a message item is open, then stream output_text deltas.
            if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    flush_reasoning(&mut w, &mut think_buf, &mut output_index, &mut think_items).await?;
                    if !text_open {
                        text_oi = output_index;
                        output_index += 1;
                        w.event(
                            "response.output_item.added",
                            json!({ "type": "response.output_item.added", "output_index": text_oi,
                                "item": { "type": "message", "id": text_item_id, "role": "assistant", "status": "in_progress", "content": [] } }),
                        )
                        .await?;
                        w.event(
                            "response.content_part.added",
                            json!({ "type": "response.content_part.added", "item_id": text_item_id, "output_index": text_oi,
                                "content_index": 0, "part": { "type": "output_text", "text": "", "annotations": [] } }),
                        )
                        .await?;
                        text_open = true;
                    }
                    text_buf.push_str(text);
                    w.event(
                        "response.output_text.delta",
                        json!({ "type": "response.output_text.delta", "item_id": text_item_id, "output_index": text_oi, "content_index": 0, "delta": text }),
                    )
                    .await?;
                }
            }

            // Tool-call deltas: a new index opens a function_call item; argument fragments stream.
            for tc in delta.get("tool_calls").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
                let tc_index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                if !tools.contains_key(&tc_index) {
                    flush_reasoning(&mut w, &mut think_buf, &mut output_index, &mut think_items).await?;
                    let oi = output_index;
                    output_index += 1;
                    let item_id = format!("fc_{}", tc_index);
                    let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("call_gateway").to_string();
                    let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    w.event(
                        "response.output_item.added",
                        json!({ "type": "response.output_item.added", "output_index": oi,
                            "item": { "type": "function_call", "id": item_id, "call_id": call_id, "name": name, "arguments": "", "status": "in_progress" } }),
                    )
                    .await?;
                    tools.insert(tc_index, RespToolAcc { output_index: oi, item_id, call_id, name, args: String::new() });
                    tool_order.push(tc_index);
                }
                if let Some(args) = tc.pointer("/function/arguments").and_then(|v| v.as_str()) {
                    if !args.is_empty() {
                        let acc = tools.get_mut(&tc_index).unwrap();
                        acc.args.push_str(args);
                        w.event(
                            "response.function_call_arguments.delta",
                            json!({ "type": "response.function_call_arguments.delta", "item_id": acc.item_id, "output_index": acc.output_index, "delta": args }),
                        )
                        .await?;
                    }
                }
            }
        }
        if done {
            break;
        }
    }

    // Trailing reasoning with no text/tool after it (e.g. an aborted turn) still surfaces.
    flush_reasoning(&mut w, &mut think_buf, &mut output_index, &mut think_items).await?;

    // Finalize each open item and assemble the completed response.output (ordered by output_index).
    let mut final_items: Vec<(u64, Value)> = think_items;
    if text_open {
        w.event(
            "response.output_text.done",
            json!({ "type": "response.output_text.done", "item_id": text_item_id, "output_index": text_oi, "content_index": 0, "text": text_buf }),
        )
        .await?;
        w.event(
            "response.content_part.done",
            json!({ "type": "response.content_part.done", "item_id": text_item_id, "output_index": text_oi, "content_index": 0,
                "part": { "type": "output_text", "text": text_buf, "annotations": [] } }),
        )
        .await?;
        let item = json!({ "type": "message", "id": text_item_id, "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": text_buf, "annotations": [] }] });
        w.event(
            "response.output_item.done",
            json!({ "type": "response.output_item.done", "output_index": text_oi, "item": item.clone() }),
        )
        .await?;
        final_items.push((text_oi, item));
    }
    for idx in &tool_order {
        let acc = &tools[idx];
        w.event(
            "response.function_call_arguments.done",
            json!({ "type": "response.function_call_arguments.done", "item_id": acc.item_id, "output_index": acc.output_index, "arguments": acc.args }),
        )
        .await?;
        let item = json!({ "type": "function_call", "id": acc.item_id, "call_id": acc.call_id, "name": acc.name, "arguments": acc.args, "status": "completed" });
        w.event(
            "response.output_item.done",
            json!({ "type": "response.output_item.done", "output_index": acc.output_index, "item": item.clone() }),
        )
        .await?;
        final_items.push((acc.output_index, item));
    }
    final_items.sort_by_key(|(i, _)| *i);
    let output: Vec<Value> = final_items.into_iter().map(|(_, v)| v).collect();

    // No text and no tool call → the model gave us nothing to render (reasoning alone doesn't
    // count). Silently completing an empty turn shows the user "no answer"; fail loudly instead
    // (a common cause: the picked model can't do tool calling, which Codex always requests).
    if !text_open && tool_order.is_empty() {
        w.event(
            "response.failed",
            json!({ "type": "response.failed", "response": { "id": "resp_gateway", "status": "failed",
                "error": { "message": "the model returned no content — it may not support tool calling; try a tool-capable model" } } }),
        )
        .await?;
        return w.sock.flush().await;
    }

    w.event(
        "response.completed",
        json!({ "type": "response.completed", "response": {
            "id": "resp_gateway", "object": "response", "status": "completed", "model": model,
            "output": output,
            "usage": { "input_tokens": usage.0, "output_tokens": usage.1, "total_tokens": usage.2 },
        } }),
    )
    .await?;
    w.sock.flush().await
}

// ---- openai-in → anthropic-out: translate /chat/completions and /responses onto /v1/messages ----
//
// The mirror image of the anthropic→openai path above. A CLI that speaks the OpenAI dialect (chat
// or Responses) can drive an Anthropic-protocol endpoint (Claude by API key, or any Messages-API
// gateway). Requests translate into an Anthropic Messages body; the Messages answer / SSE stream
// translates back into the CLI's dialect. Reasoning is *not* forwarded upstream (Anthropic
// `thinking` is model-gated and would 400 on an unknown-capability target); any thinking the model
// *returns* is surfaced back (reasoning_content / a Responses reasoning item).

// Anthropic requires `max_tokens`. Read the cap under whichever name the OpenAI dialect used;
// default when the CLI omits it.
fn anthropic_max_tokens(req: &Value) -> u64 {
    for k in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if let Some(n) = req.get(k).and_then(|v| v.as_u64()) {
            return n;
        }
    }
    8192
}

// A "data:...;base64,..." URI → an Anthropic image content block. None if it isn't a base64 data URI.
fn data_uri_to_image_block(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (media_type, data) = rest.split_once(";base64,")?;
    Some(json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }))
}

// Append a block to the last message if it's an open turn of `role` with array content (Anthropic
// requires roles to alternate — consecutive tool_results must share one user turn), else start a
// fresh turn of that role.
fn push_block(messages: &mut Vec<Value>, role: &str, block: Value) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(|v| v.as_str()) == Some(role) {
            if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                arr.push(block);
                return;
            }
        }
    }
    messages.push(json!({ "role": role, "content": [block] }));
}

// OpenAI chat `stop` (string or array) → Anthropic `stop_sequences` (array).
fn normalize_stops(stops: &Value) -> Value {
    match stops {
        Value::String(s) => json!([s]),
        Value::Array(_) => stops.clone(),
        _ => json!([]),
    }
}

// OpenAI tool entries → Anthropic tools. `flat` picks the Responses shape ({type,name,…}) vs the
// chat shape ({type:"function", function:{…}}).
fn openai_tools_to_anthropic(tools: &[Value], flat: bool) -> Option<Value> {
    let mapped: Vec<Value> = tools
        .iter()
        .filter_map(|t| {
            let src = if flat {
                (t.get("type").and_then(|v| v.as_str()) == Some("function")).then_some(t)?
            } else {
                t.get("function")?
            };
            src.get("name")?;
            Some(json!({
                "name": src.get("name").cloned().unwrap_or(Value::Null),
                "description": src.get("description").cloned().unwrap_or(Value::Null),
                "input_schema": src.get("parameters").cloned().unwrap_or(json!({ "type": "object" })),
            }))
        })
        .collect();
    (!mapped.is_empty()).then_some(Value::Array(mapped))
}

// OpenAI tool_choice (chat or Responses) → Anthropic tool_choice. "none"/unknown → None (omit).
fn openai_tool_choice_to_anthropic(tc: Option<&Value>) -> Option<Value> {
    match tc {
        Some(Value::String(s)) => match s.as_str() {
            "required" => Some(json!({ "type": "any" })),
            "auto" => Some(json!({ "type": "auto" })),
            _ => None,
        },
        Some(Value::Object(_)) => {
            // chat: {type:"function", function:{name}}; Responses: {type:"function", name}
            let name = tc
                .and_then(|v| v.pointer("/function/name").or_else(|| v.get("name")))
                .cloned();
            name.map(|n| json!({ "type": "tool", "name": n }))
        }
        _ => None,
    }
}

// OpenAI chat/completions request → Anthropic Messages request.
fn chat_to_anthropic(req: &Value) -> Value {
    let mut system = String::new();
    let mut messages: Vec<Value> = Vec::new();

    for m in req.get("messages").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
        match m.get("role").and_then(|v| v.as_str()).unwrap_or("user") {
            "system" | "developer" => {
                let text = tool_result_text(m.get("content"));
                if !text.is_empty() {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(&text);
                }
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                let text = tool_result_text(m.get("content"));
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                for tc in m.get("tool_calls").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
                    let args = tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "name": tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or(""),
                        "input": serde_json::from_str::<Value>(args).unwrap_or(json!({})),
                    }));
                }
                if !blocks.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            "tool" => push_block(
                &mut messages,
                "user",
                json!({
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                    "content": tool_result_text(m.get("content")),
                }),
            ),
            _ => match m.get("content") {
                Some(Value::String(s)) => messages.push(json!({ "role": "user", "content": s })),
                Some(Value::Array(parts)) => {
                    let blocks = openai_parts_to_anthropic(parts);
                    if !blocks.is_empty() {
                        messages.push(json!({ "role": "user", "content": blocks }));
                    }
                }
                _ => {}
            },
        }
    }

    let mut out = json!({
        "model": req.get("model").cloned().unwrap_or(Value::Null),
        "max_tokens": anthropic_max_tokens(req),
        "messages": messages,
    });
    if !system.is_empty() {
        out["system"] = json!(system);
    }
    if req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false) {
        out["stream"] = json!(true);
    }
    if let Some(stops) = req.get("stop") {
        out["stop_sequences"] = normalize_stops(stops);
    }
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()) {
        if let Some(mapped) = openai_tools_to_anthropic(tools, false) {
            out["tools"] = mapped;
        }
    }
    if let Some(tc) = openai_tool_choice_to_anthropic(req.get("tool_choice")) {
        out["tool_choice"] = tc;
    }
    out
}

// OpenAI chat content parts (text / image_url) → Anthropic content blocks.
fn openai_parts_to_anthropic(parts: &[Value]) -> Vec<Value> {
    let mut blocks = Vec::new();
    for p in parts {
        match p.get("type").and_then(|v| v.as_str()) {
            Some("text") => blocks.push(json!({ "type": "text", "text": p.get("text").and_then(|v| v.as_str()).unwrap_or("") })),
            Some("image_url") => {
                if let Some(block) = p.pointer("/image_url/url").and_then(|v| v.as_str()).and_then(data_uri_to_image_block) {
                    blocks.push(block);
                }
            }
            _ => {}
        }
    }
    blocks
}

// Responses content parts → flat text (for system/developer input messages).
fn responses_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

// Responses content (string or typed parts) → Anthropic content blocks.
fn responses_content_to_anthropic(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::String(s)) if !s.is_empty() => vec![json!({ "type": "text", "text": s })],
        Some(Value::Array(parts)) => {
            let mut blocks = Vec::new();
            for p in parts {
                match p.get("type").and_then(|v| v.as_str()) {
                    Some("input_text") | Some("output_text") | Some("text") => {
                        blocks.push(json!({ "type": "text", "text": p.get("text").and_then(|v| v.as_str()).unwrap_or("") }))
                    }
                    Some("input_image") => {
                        if let Some(block) = p.get("image_url").and_then(|v| v.as_str()).and_then(data_uri_to_image_block) {
                            blocks.push(block);
                        }
                    }
                    _ => {}
                }
            }
            blocks
        }
        _ => Vec::new(),
    }
}

// OpenAI Responses request → Anthropic Messages request.
fn responses_to_anthropic(req: &Value) -> Value {
    let mut system = req.get("instructions").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut messages: Vec<Value> = Vec::new();

    match req.get("input") {
        Some(Value::String(s)) => messages.push(json!({ "role": "user", "content": s })),
        Some(Value::Array(items)) => {
            for it in items {
                match it.get("type").and_then(|v| v.as_str()) {
                    Some("message") | None => {
                        let role = it.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                        if role == "system" || role == "developer" {
                            let text = responses_content_text(it.get("content"));
                            if !text.is_empty() {
                                if !system.is_empty() {
                                    system.push_str("\n\n");
                                }
                                system.push_str(&text);
                            }
                            continue;
                        }
                        let blocks = responses_content_to_anthropic(it.get("content"));
                        if !blocks.is_empty() {
                            let ar = if role == "assistant" { "assistant" } else { "user" };
                            messages.push(json!({ "role": ar, "content": blocks }));
                        }
                    }
                    Some("function_call") => {
                        let args = it.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                        push_block(
                            &mut messages,
                            "assistant",
                            json!({
                                "type": "tool_use",
                                "id": it.get("call_id").or_else(|| it.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
                                "name": it.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                "input": serde_json::from_str::<Value>(args).unwrap_or(json!({})),
                            }),
                        );
                    }
                    Some("function_call_output") => {
                        let output = match it.get("output") {
                            Some(Value::String(s)) => s.clone(),
                            Some(v) => v.to_string(),
                            None => String::new(),
                        };
                        push_block(
                            &mut messages,
                            "user",
                            json!({
                                "type": "tool_result",
                                "tool_use_id": it.get("call_id").and_then(|v| v.as_str()).unwrap_or(""),
                                "content": output,
                            }),
                        );
                    }
                    _ => {} // reasoning items et al. — drop
                }
            }
        }
        _ => {}
    }

    let mut out = json!({
        "model": req.get("model").cloned().unwrap_or(Value::Null),
        "max_tokens": anthropic_max_tokens(req),
        "messages": messages,
    });
    if !system.is_empty() {
        out["system"] = json!(system);
    }
    if req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false) {
        out["stream"] = json!(true);
    }
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()) {
        if let Some(mapped) = openai_tools_to_anthropic(tools, true) {
            out["tools"] = mapped;
        }
    }
    if let Some(tc) = openai_tool_choice_to_anthropic(req.get("tool_choice")) {
        out["tool_choice"] = tc;
    }
    out
}

// Anthropic stop_reason → OpenAI finish_reason.
fn anthropic_stop_to_openai(reason: Option<&str>) -> &'static str {
    match reason {
        Some("tool_use") => "tool_calls",
        Some("max_tokens") => "length",
        _ => "stop",
    }
}

// POST a translated Messages request to {base}/v1/messages. On transport failure or a non-2xx
// status the provider's own message is written to `sock` (readable in the transcript) and None is
// returned. Mirrors send_chat, one API over.
async fn send_messages(
    sock: &mut TcpStream,
    base: &str,
    key: &str,
    headers_in: &[(String, String)],
    msg_req: &Value,
) -> std::io::Result<Option<reqwest::Response>> {
    let url = format!("{}/v1/messages", base.trim_end_matches('/'));
    let upstream = anthropic_auth(http_client().post(&url), key, headers_in)
        .header("content-type", "application/json")
        .body(msg_req.to_string())
        .send()
        .await;
    let upstream = match upstream {
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

// Anthropic non-stream Messages response → OpenAI chat/completions response.
fn anthropic_to_chat(j: &Value, model: &str) -> Value {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    for block in j.get("content").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => text.push_str(block.get("text").and_then(|v| v.as_str()).unwrap_or("")),
            Some("thinking") => reasoning.push_str(block.get("thinking").and_then(|v| v.as_str()).unwrap_or("")),
            Some("tool_use") => tool_calls.push(json!({
                "id": block.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "type": "function",
                "function": {
                    "name": block.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "arguments": block.get("input").map(|i| i.to_string()).unwrap_or_else(|| "{}".into()),
                },
            })),
            _ => {}
        }
    }
    let mut message = json!({ "role": "assistant" });
    message["content"] = if text.is_empty() { Value::Null } else { Value::String(text) };
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    let in_tok = j.pointer("/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let out_tok = j.pointer("/usage/output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    json!({
        "id": j.get("id").and_then(|v| v.as_str()).unwrap_or("chatcmpl_gateway"),
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": anthropic_stop_to_openai(j.get("stop_reason").and_then(|v| v.as_str())),
        }],
        "usage": { "prompt_tokens": in_tok, "completion_tokens": out_tok, "total_tokens": in_tok + out_tok },
    })
}

// Anthropic non-stream Messages response → OpenAI Responses response object.
fn anthropic_to_responses(j: &Value, model: &str) -> Value {
    let mut output: Vec<Value> = Vec::new();
    let mut fc_i = 0;
    for block in j.get("content").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("thinking") => output.push(json!({
                "type": "reasoning", "id": "rs_0",
                "summary": [{ "type": "summary_text", "text": block.get("thinking").and_then(|v| v.as_str()).unwrap_or("") }],
            })),
            Some("text") => output.push(json!({
                "type": "message", "id": "msg_gateway", "role": "assistant", "status": "completed",
                "content": [{ "type": "output_text", "text": block.get("text").and_then(|v| v.as_str()).unwrap_or(""), "annotations": [] }],
            })),
            Some("tool_use") => {
                output.push(json!({
                    "type": "function_call",
                    "id": format!("fc_{}", fc_i),
                    "call_id": block.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "name": block.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "arguments": block.get("input").map(|i| i.to_string()).unwrap_or_else(|| "{}".into()),
                    "status": "completed",
                }));
                fc_i += 1;
            }
            _ => {}
        }
    }
    let in_tok = j.pointer("/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let out_tok = j.pointer("/usage/output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    json!({
        "id": "resp_gateway", "object": "response", "status": "completed", "model": model,
        "output": output,
        "usage": { "input_tokens": in_tok, "output_tokens": out_tok, "total_tokens": in_tok + out_tok },
    })
}

async fn proxy_chat_to_anthropic(sock: &mut TcpStream, base: &str, key: &str, headers_in: &[(String, String)], body: &[u8]) -> std::io::Result<()> {
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        return respond_json(sock, 400, &err_body("invalid_request_error", "bad JSON")).await;
    };
    let stream = req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let model = req.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let msg_req = chat_to_anthropic(&req);
    let Some(upstream) = send_messages(sock, base, key, headers_in, &msg_req).await? else {
        return Ok(());
    };
    if stream {
        stream_anthropic_as_chat(sock, upstream, &model).await
    } else {
        respond_translated(sock, upstream, &model, anthropic_to_chat).await
    }
}

async fn proxy_responses_to_anthropic(sock: &mut TcpStream, base: &str, key: &str, headers_in: &[(String, String)], body: &[u8]) -> std::io::Result<()> {
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        return respond_json(sock, 400, &err_body("invalid_request_error", "bad JSON")).await;
    };
    let stream = req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let model = req.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let msg_req = responses_to_anthropic(&req);
    let Some(upstream) = send_messages(sock, base, key, headers_in, &msg_req).await? else {
        return Ok(());
    };
    if stream {
        stream_anthropic_as_responses(sock, upstream, &model).await
    } else {
        respond_translated(sock, upstream, &model, anthropic_to_responses).await
    }
}

// Write one OpenAI SSE frame (`data: {json}\n\n`).
async fn write_sse_data(sock: &mut TcpStream, v: &Value) -> std::io::Result<()> {
    let frame = format!("data: {}\n\n", v);
    sock.write_all(frame.as_bytes()).await
}

fn chat_chunk(model: &str, delta: Value) -> Value {
    json!({
        "id": "chatcmpl_gateway", "object": "chat.completion.chunk", "model": model,
        "choices": [{ "index": 0, "delta": delta, "finish_reason": Value::Null }],
    })
}

// ---- streaming translation (Anthropic SSE events → OpenAI chat/completions chunks) ----
async fn stream_anthropic_as_chat(sock: &mut TcpStream, upstream: reqwest::Response, model: &str) -> std::io::Result<()> {
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
    )
    .await?;

    // anthropic block index → openai tool_call slot; `role` rides only the first delta.
    let mut tool_slots: std::collections::HashMap<u64, u64> = std::collections::HashMap::new();
    let mut next_tool: u64 = 0;
    let mut role_sent = false;
    let mut any = false;
    let mut finish: Option<String> = None;
    let mut usage: (u64, u64) = (0, 0);

    let mut buf = String::new();
    let mut bytes = upstream.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let Ok(chunk) = chunk else { break };
        let (events, _done) = drain_sse(&mut buf, &chunk);
        for j in events {
            match j.get("type").and_then(|v| v.as_str()) {
                Some("message_start") => {
                    usage.0 = j.pointer("/message/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                }
                Some("content_block_start") if j.pointer("/content_block/type").and_then(|v| v.as_str()) == Some("tool_use") => {
                    let index = j.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    let slot = next_tool;
                    next_tool += 1;
                    tool_slots.insert(index, slot);
                    let mut delta = json!({ "tool_calls": [{
                        "index": slot,
                        "id": j.pointer("/content_block/id").and_then(|v| v.as_str()).unwrap_or(""),
                        "type": "function",
                        "function": { "name": j.pointer("/content_block/name").and_then(|v| v.as_str()).unwrap_or(""), "arguments": "" },
                    }] });
                    if !role_sent {
                        delta["role"] = json!("assistant");
                        role_sent = true;
                    }
                    write_sse_data(sock, &chat_chunk(model, delta)).await?;
                    any = true;
                }
                Some("content_block_delta") => {
                    let index = j.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    match j.pointer("/delta/type").and_then(|v| v.as_str()).unwrap_or("") {
                        "text_delta" => {
                            let mut delta = json!({ "content": j.pointer("/delta/text").and_then(|v| v.as_str()).unwrap_or("") });
                            if !role_sent {
                                delta["role"] = json!("assistant");
                                role_sent = true;
                            }
                            write_sse_data(sock, &chat_chunk(model, delta)).await?;
                            any = true;
                        }
                        "thinking_delta" => {
                            let mut delta = json!({ "reasoning_content": j.pointer("/delta/thinking").and_then(|v| v.as_str()).unwrap_or("") });
                            if !role_sent {
                                delta["role"] = json!("assistant");
                                role_sent = true;
                            }
                            write_sse_data(sock, &chat_chunk(model, delta)).await?;
                            any = true;
                        }
                        "input_json_delta" => {
                            if let Some(&slot) = tool_slots.get(&index) {
                                let partial = j.pointer("/delta/partial_json").and_then(|v| v.as_str()).unwrap_or("");
                                let delta = json!({ "tool_calls": [{ "index": slot, "function": { "arguments": partial } }] });
                                write_sse_data(sock, &chat_chunk(model, delta)).await?;
                                any = true;
                            }
                        }
                        _ => {}
                    }
                }
                Some("message_delta") => {
                    if let Some(sr) = j.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                        finish = Some(anthropic_stop_to_openai(Some(sr)).to_string());
                    }
                    if let Some(o) = j.pointer("/usage/output_tokens").and_then(|v| v.as_u64()) {
                        usage.1 = o;
                    }
                }
                Some("error") => {
                    let msg = j.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("upstream error");
                    write_sse_data(sock, &json!({ "error": { "message": msg } })).await?;
                    return sock.flush().await;
                }
                _ => {} // message_stop / ping / content_block_stop — nothing to emit
            }
        }
    }

    if !any && finish.is_none() {
        write_sse_data(sock, &json!({ "error": { "message": "upstream returned an empty response" } })).await?;
        return sock.flush().await;
    }
    let final_chunk = json!({
        "id": "chatcmpl_gateway", "object": "chat.completion.chunk", "model": model,
        "choices": [{ "index": 0, "delta": {}, "finish_reason": finish.as_deref().unwrap_or("stop") }],
        "usage": { "prompt_tokens": usage.0, "completion_tokens": usage.1, "total_tokens": usage.0 + usage.1 },
    });
    write_sse_data(sock, &final_chunk).await?;
    sock.write_all(b"data: [DONE]\n\n").await?;
    sock.flush().await
}

// ---- streaming translation (Anthropic SSE events → OpenAI Responses SSE events) ----
async fn stream_anthropic_as_responses(sock: &mut TcpStream, upstream: reqwest::Response, model: &str) -> std::io::Result<()> {
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
    )
    .await?;

    let mut w = RespWriter { sock, seq: 0 };
    w.event(
        "response.created",
        json!({ "type": "response.created", "response": { "id": "resp_gateway", "object": "response", "status": "in_progress", "model": model, "output": [] } }),
    )
    .await?;

    let mut output_index: u64 = 0;
    let mut text_open = false;
    let text_item_id = "msg_0";
    let mut text_oi: u64 = 0;
    let mut text_buf = String::new();
    let mut think_buf = String::new();
    let mut think_items: Vec<(u64, Value)> = Vec::new();
    // anthropic block index → accumulated function call
    let mut tools: std::collections::HashMap<u64, RespToolAcc> = std::collections::HashMap::new();
    let mut tool_order: Vec<u64> = Vec::new();
    let mut usage: (u64, u64) = (0, 0);

    let mut buf = String::new();
    let mut bytes = upstream.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let Ok(chunk) = chunk else { break };
        let (events, _done) = drain_sse(&mut buf, &chunk);
        for j in events {
            match j.get("type").and_then(|v| v.as_str()) {
                Some("message_start") => {
                    usage.0 = j.pointer("/message/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                }
                Some("content_block_start") if j.pointer("/content_block/type").and_then(|v| v.as_str()) == Some("tool_use") => {
                    flush_reasoning(&mut w, &mut think_buf, &mut output_index, &mut think_items).await?;
                    let index = j.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    let oi = output_index;
                    output_index += 1;
                    let item_id = format!("fc_{}", index);
                    let call_id = j.pointer("/content_block/id").and_then(|v| v.as_str()).unwrap_or("call_gateway").to_string();
                    let name = j.pointer("/content_block/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    w.event(
                        "response.output_item.added",
                        json!({ "type": "response.output_item.added", "output_index": oi,
                            "item": { "type": "function_call", "id": item_id, "call_id": call_id, "name": name, "arguments": "", "status": "in_progress" } }),
                    )
                    .await?;
                    tools.insert(index, RespToolAcc { output_index: oi, item_id, call_id, name, args: String::new() });
                    tool_order.push(index);
                }
                Some("content_block_delta") => {
                    let index = j.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    match j.pointer("/delta/type").and_then(|v| v.as_str()).unwrap_or("") {
                        "thinking_delta" => think_buf.push_str(j.pointer("/delta/thinking").and_then(|v| v.as_str()).unwrap_or("")),
                        "text_delta" => {
                            let text = j.pointer("/delta/text").and_then(|v| v.as_str()).unwrap_or("");
                            if !text.is_empty() {
                                flush_reasoning(&mut w, &mut think_buf, &mut output_index, &mut think_items).await?;
                                if !text_open {
                                    text_oi = output_index;
                                    output_index += 1;
                                    w.event(
                                        "response.output_item.added",
                                        json!({ "type": "response.output_item.added", "output_index": text_oi,
                                            "item": { "type": "message", "id": text_item_id, "role": "assistant", "status": "in_progress", "content": [] } }),
                                    )
                                    .await?;
                                    w.event(
                                        "response.content_part.added",
                                        json!({ "type": "response.content_part.added", "item_id": text_item_id, "output_index": text_oi,
                                            "content_index": 0, "part": { "type": "output_text", "text": "", "annotations": [] } }),
                                    )
                                    .await?;
                                    text_open = true;
                                }
                                text_buf.push_str(text);
                                w.event(
                                    "response.output_text.delta",
                                    json!({ "type": "response.output_text.delta", "item_id": text_item_id, "output_index": text_oi, "content_index": 0, "delta": text }),
                                )
                                .await?;
                            }
                        }
                        "input_json_delta" => {
                            if let Some(acc) = tools.get_mut(&index) {
                                let partial = j.pointer("/delta/partial_json").and_then(|v| v.as_str()).unwrap_or("");
                                if !partial.is_empty() {
                                    acc.args.push_str(partial);
                                    w.event(
                                        "response.function_call_arguments.delta",
                                        json!({ "type": "response.function_call_arguments.delta", "item_id": acc.item_id, "output_index": acc.output_index, "delta": partial }),
                                    )
                                    .await?;
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Some("message_delta") => {
                    if let Some(o) = j.pointer("/usage/output_tokens").and_then(|v| v.as_u64()) {
                        usage.1 = o;
                    }
                }
                Some("error") => {
                    let msg = j.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("upstream error");
                    w.event(
                        "response.failed",
                        json!({ "type": "response.failed", "response": { "id": "resp_gateway", "status": "failed", "error": { "message": msg } } }),
                    )
                    .await?;
                    return w.sock.flush().await;
                }
                _ => {}
            }
        }
    }

    flush_reasoning(&mut w, &mut think_buf, &mut output_index, &mut think_items).await?;

    let mut final_items: Vec<(u64, Value)> = think_items;
    if text_open {
        w.event(
            "response.output_text.done",
            json!({ "type": "response.output_text.done", "item_id": text_item_id, "output_index": text_oi, "content_index": 0, "text": text_buf }),
        )
        .await?;
        w.event(
            "response.content_part.done",
            json!({ "type": "response.content_part.done", "item_id": text_item_id, "output_index": text_oi, "content_index": 0,
                "part": { "type": "output_text", "text": text_buf, "annotations": [] } }),
        )
        .await?;
        let item = json!({ "type": "message", "id": text_item_id, "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": text_buf, "annotations": [] }] });
        w.event(
            "response.output_item.done",
            json!({ "type": "response.output_item.done", "output_index": text_oi, "item": item.clone() }),
        )
        .await?;
        final_items.push((text_oi, item));
    }
    for idx in &tool_order {
        let acc = &tools[idx];
        w.event(
            "response.function_call_arguments.done",
            json!({ "type": "response.function_call_arguments.done", "item_id": acc.item_id, "output_index": acc.output_index, "arguments": acc.args }),
        )
        .await?;
        let item = json!({ "type": "function_call", "id": acc.item_id, "call_id": acc.call_id, "name": acc.name, "arguments": acc.args, "status": "completed" });
        w.event(
            "response.output_item.done",
            json!({ "type": "response.output_item.done", "output_index": acc.output_index, "item": item.clone() }),
        )
        .await?;
        final_items.push((acc.output_index, item));
    }
    final_items.sort_by_key(|(i, _)| *i);
    let output: Vec<Value> = final_items.into_iter().map(|(_, v)| v).collect();

    if !text_open && tool_order.is_empty() {
        w.event(
            "response.failed",
            json!({ "type": "response.failed", "response": { "id": "resp_gateway", "status": "failed",
                "error": { "message": "the model returned no content" } } }),
        )
        .await?;
        return w.sock.flush().await;
    }

    w.event(
        "response.completed",
        json!({ "type": "response.completed", "response": {
            "id": "resp_gateway", "object": "response", "status": "completed", "model": model,
            "output": output,
            "usage": { "input_tokens": usage.0, "output_tokens": usage.1, "total_tokens": usage.0 + usage.1 },
        } }),
    )
    .await?;
    w.sock.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_result_text_flattens_string_and_array_content() {
        assert_eq!(tool_result_text(Some(&json!("plain"))), "plain");
        let arr = json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }]);
        assert_eq!(tool_result_text(Some(&arr)), "ab");
        assert_eq!(tool_result_text(None), "");
        assert_eq!(tool_result_text(Some(&json!(42))), ""); // non-text → empty
    }

    #[test]
    fn map_stop_maps_finish_reasons() {
        assert_eq!(map_stop(Some("tool_calls")), "tool_use");
        assert_eq!(map_stop(Some("length")), "max_tokens");
        assert_eq!(map_stop(Some("stop")), "end_turn");
        assert_eq!(map_stop(None), "end_turn");
    }

    // Minimal one-shot mock upstream: accepts one connection, reads the request head + body,
    // answers with the given raw HTTP response, closes.
    async fn mock_upstream(response: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut sock).await;
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.flush().await.unwrap();
        });
        port
    }

    // Drive one authorized POST through the gateway and return the full raw response.
    async fn roundtrip(gw: &Gateway, path: &str, body: &str) -> String {
        let mut sock = TcpStream::connect(("127.0.0.1", gw.port)).await.unwrap();
        let req = format!(
            "POST {} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            path,
            gw.token,
            body.len(),
            body
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        sock.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).to_string()
    }

    fn sse(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
            body
        )
    }

    fn json_resp(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    async fn anthropic_gw(port: u16, inbound: Proto) -> Gateway {
        start(GatewayConfig {
            inbound,
            outbound: Proto::Anthropic,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn translates_openai_stream_to_anthropic_events() {
        let upstream = sse(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::Anthropic,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(&gw, "/v1/messages", r#"{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: message_start"), "no message_start: {resp}");
        assert!(resp.contains(r#""text":"hel"#), "no text delta: {resp}");
        assert!(resp.contains(r#""stop_reason":"end_turn""#), "no stop_reason: {resp}");
        assert!(resp.contains("event: message_stop"), "no message_stop: {resp}");
    }

    // OpenRouter-style failure: 200 + {"error": …} inside the stream. Must surface as an SSE
    // error event, not an empty assistant message (which sends the CLI into endless retries).
    #[tokio::test]
    async fn surfaces_mid_stream_error() {
        let upstream = sse("data: {\"error\":{\"message\":\"rate limited\",\"code\":429}}\n\ndata: [DONE]\n\n");
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::Anthropic,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(&gw, "/v1/messages", r#"{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: error"), "no error event: {resp}");
        assert!(resp.contains("rate limited"), "message lost: {resp}");
        assert!(!resp.contains("message_stop"), "empty message still emitted: {resp}");
    }

    // Upstream that streams nothing usable → loud error instead of an empty message.
    #[tokio::test]
    async fn empty_stream_fails_loudly() {
        let upstream = sse("data: [DONE]\n\n");
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::Anthropic,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(&gw, "/v1/messages", r#"{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: error"), "no error event: {resp}");
        assert!(resp.contains("empty response"), "wrong message: {resp}");
    }

    // Anthropic→Anthropic passthrough must tunnel SSE bytes untouched.
    #[tokio::test]
    async fn anthropic_passthrough_tunnels_sse() {
        let upstream = sse("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::Anthropic,
            outbound: Proto::Anthropic,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(&gw, "/v1/messages", r#"{"model":"m","stream":true}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: message_start"), "sse not tunneled: {resp}");
    }

    // Codex Responses request → chat/completions upstream → Responses SSE back, incl. a tool call.
    #[tokio::test]
    async fn translates_chat_stream_to_responses_events() {
        let upstream = sse(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"ls\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\n",
            "data: [DONE]\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::OpenAi,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(
            &gw,
            "/v1/responses",
            r#"{"model":"m","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}"#,
        )
        .await;
        gw.shutdown();
        assert!(resp.contains("event: response.created"), "no created: {resp}");
        assert!(resp.contains(r#""delta":"hel"#), "no text delta: {resp}");
        assert!(resp.contains("event: response.function_call_arguments.done"), "no tool done: {resp}");
        assert!(resp.contains(r#""call_id":"call_1""#), "call_id lost: {resp}");
        assert!(resp.contains("event: response.completed"), "no completed: {resp}");
        assert!(resp.contains(r#""input_tokens":5"#), "usage lost: {resp}");
    }

    // DeepSeek/OpenRouter reasoning deltas → an Anthropic thinking block, closed before the text.
    #[tokio::test]
    async fn translates_reasoning_to_thinking_block() {
        let upstream = sse(concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::Anthropic,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(&gw, "/v1/messages", r#"{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
        gw.shutdown();
        assert!(resp.contains(r#""type":"thinking""#), "no thinking block: {resp}");
        assert!(resp.contains(r#""thinking":"hmm""#), "reasoning lost: {resp}");
        assert!(resp.contains(r#""text":"hi""#), "text lost: {resp}");
        let think = resp.find(r#""thinking":"hmm""#).unwrap();
        let text = resp.find(r#""text":"hi""#).unwrap();
        assert!(think < text, "thinking must precede text: {resp}");
    }

    // Reasoning deltas on the Responses path → a reasoning output item before the message.
    #[tokio::test]
    async fn translates_reasoning_to_responses_item() {
        let upstream = sse(concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"hmm\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::OpenAi,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
        })
        .await
        .unwrap();

        let resp = roundtrip(
            &gw,
            "/v1/responses",
            r#"{"model":"m","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}"#,
        )
        .await;
        gw.shutdown();
        assert!(resp.contains(r#""type":"reasoning""#), "no reasoning item: {resp}");
        assert!(resp.contains(r#""text":"hmm","type":"summary_text""#), "reasoning lost: {resp}");
        assert!(resp.contains(r#""delta":"hi""#), "text lost: {resp}");
        assert!(resp.contains("event: response.completed"), "no completed: {resp}");
    }

    // ---- openai-in → anthropic-out ----

    // Codex Responses request → Anthropic /v1/messages → Responses SSE back, incl. thinking + a tool call.
    #[tokio::test]
    async fn translates_anthropic_stream_to_responses_events() {
        let upstream = sse(concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"ls\",\"input\":{}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = anthropic_gw(port, Proto::OpenAi).await;

        let resp = roundtrip(
            &gw,
            "/v1/responses",
            r#"{"model":"m","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}"#,
        )
        .await;
        gw.shutdown();
        assert!(resp.contains("event: response.created"), "no created: {resp}");
        assert!(resp.contains(r#""type":"reasoning""#), "no reasoning item: {resp}");
        assert!(resp.contains(r#""text":"hmm""#), "reasoning lost: {resp}");
        assert!(resp.contains("event: response.function_call_arguments.done"), "no tool done: {resp}");
        assert!(resp.contains(r#""call_id":"toolu_1""#), "call_id lost: {resp}");
        assert!(resp.contains("event: response.completed"), "no completed: {resp}");
        assert!(resp.contains(r#""input_tokens":5"#), "usage lost: {resp}");
    }

    // chat/completions request → Anthropic /v1/messages → chat SSE chunks, text + tool call.
    #[tokio::test]
    async fn translates_anthropic_stream_to_chat_chunks() {
        let upstream = sse(concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4}}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_9\",\"name\":\"ls\",\"input\":{}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":3}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = anthropic_gw(port, Proto::OpenAi).await;

        let resp = roundtrip(&gw, "/v1/chat/completions", r#"{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}"#).await;
        gw.shutdown();
        assert!(resp.contains(r#""content":"hi""#), "no text delta: {resp}");
        assert!(resp.contains(r#""name":"ls""#), "no tool call: {resp}");
        assert!(resp.contains(r#""finish_reason":"tool_calls""#), "no finish: {resp}");
        assert!(resp.contains("data: [DONE]"), "no DONE: {resp}");
    }

    #[tokio::test]
    async fn translates_anthropic_nonstream_to_responses() {
        let body = r#"{"id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}"#;
        let port = mock_upstream(Box::leak(json_resp(body).into_boxed_str())).await;
        let gw = anthropic_gw(port, Proto::OpenAi).await;

        let resp = roundtrip(&gw, "/v1/responses", r#"{"model":"m","input":"hi"}"#).await;
        gw.shutdown();
        assert!(resp.contains(r#""object":"response""#), "not a response object: {resp}");
        assert!(resp.contains(r#""text":"hello""#), "text lost: {resp}");
        assert!(resp.contains(r#""input_tokens":3"#), "usage lost: {resp}");
    }

    #[tokio::test]
    async fn translates_anthropic_nonstream_to_chat() {
        let body = r#"{"id":"m1","type":"message","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}"#;
        let port = mock_upstream(Box::leak(json_resp(body).into_boxed_str())).await;
        let gw = anthropic_gw(port, Proto::OpenAi).await;

        let resp = roundtrip(&gw, "/v1/chat/completions", r#"{"model":"m","messages":[{"role":"user","content":"hi"}]}"#).await;
        gw.shutdown();
        assert!(resp.contains(r#""object":"chat.completion""#), "not a chat.completion: {resp}");
        assert!(resp.contains(r#""content":"hello""#), "text lost: {resp}");
        assert!(resp.contains(r#""finish_reason":"stop""#), "finish lost: {resp}");
    }

    // Anthropic mid-stream error → response.failed so Codex aborts instead of retrying an empty turn.
    #[tokio::test]
    async fn surfaces_anthropic_stream_error() {
        let upstream = sse("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"overloaded\"}}\n\n");
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = anthropic_gw(port, Proto::OpenAi).await;

        let resp = roundtrip(&gw, "/v1/responses", r#"{"model":"m","stream":true,"input":"hi"}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: response.failed"), "no failed event: {resp}");
        assert!(resp.contains("overloaded"), "message lost: {resp}");
        assert!(!resp.contains("response.completed"), "completed still emitted: {resp}");
    }

    #[test]
    fn responses_to_anthropic_maps_system_tools_and_defaults_max_tokens() {
        let req = json!({
            "model": "m",
            "instructions": "be nice",
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
                {"type":"function_call","call_id":"c1","name":"ls","arguments":"{\"a\":1}"},
                {"type":"function_call_output","call_id":"c1","output":"file.txt"}
            ],
            "tools": [{"type":"function","name":"ls","description":"list","parameters":{"type":"object"}}],
            "tool_choice": "auto"
        });
        let out = responses_to_anthropic(&req);
        assert_eq!(out["system"], json!("be nice"));
        assert_eq!(out["max_tokens"], json!(8192)); // required by Anthropic; defaulted
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3); // user, assistant(tool_use), user(tool_result)
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["id"], "c1");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "c1");
        assert_eq!(out["tools"][0]["name"], "ls");
        assert_eq!(out["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(out["tool_choice"], json!({ "type": "auto" }));
    }

    #[test]
    fn chat_to_anthropic_extracts_system_and_maps_tool_role() {
        let req = json!({
            "model": "m",
            "max_tokens": 1000,
            "messages": [
                {"role":"system","content":"sys"},
                {"role":"user","content":"hi"},
                {"role":"assistant","content":null,"tool_calls":[{"id":"t1","type":"function","function":{"name":"ls","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"t1","content":"out"}
            ]
        });
        let out = chat_to_anthropic(&req);
        assert_eq!(out["system"], "sys");
        assert_eq!(out["max_tokens"], 1000); // caller's cap is honored
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "t1");
    }

    #[tokio::test]
    async fn rejects_bad_token() {
        let gw = start(GatewayConfig {
            inbound: Proto::Anthropic,
            outbound: Proto::OpenAi,
            target_base: "http://127.0.0.1:1".into(),
            api_key: "k".into(),
        })
        .await
        .unwrap();
        let mut sock = TcpStream::connect(("127.0.0.1", gw.port)).await.unwrap();
        sock.write_all(b"POST /v1/messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer wrong\r\nContent-Length: 2\r\n\r\n{}")
            .await
            .unwrap();
        let mut out = Vec::new();
        sock.read_to_end(&mut out).await.unwrap();
        gw.shutdown();
        assert!(String::from_utf8_lossy(&out).contains("401"), "not rejected");
    }
}
