use super::http::{as_slice, drain_sse, err_body, respond_json, respond_translated, send_chat, upstream_error, SseWriter};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

// ---- /v1/messages: translate and forward (anthropic-in → openai-out) ----

pub(super) async fn proxy_messages(
    sock: &mut TcpStream,
    base: &str,
    key: &str,
    body: &[u8],
    effort: &str,
) -> std::io::Result<()> {
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        return respond_json(sock, 400, &err_body("invalid_request_error", "bad JSON")).await;
    };
    let stream = req.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let model = req.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let openai_req = to_openai_request(&req, base, stream, effort);

    let Some(upstream) = send_chat(sock, base, key, &openai_req).await? else {
        return Ok(());
    };
    if stream {
        stream_response(sock, upstream, &model).await
    } else {
        respond_translated(sock, upstream, &model, to_anthropic_response).await
    }
}

// OpenRouter's `reasoning` field for a routed run. Driven solely by the level the user picked in
// the app (GatewayConfig::effort) — reasoning stays opt-in, matching how Chat mode treats
// OpenRouter. Deliberately NOT read off the request: the CLI sends thinking:{type:"adaptive"} and
// its own default output_config.effort on every call, so the body always looks like a request for
// reasoning and would silently bill every routed run for it. "" (Auto) → no field at all.
// OpenRouter tops out at high, so the Anthropic-only xhigh/max clamp down.
pub(super) fn to_openrouter_reasoning(effort: &str) -> Option<Value> {
    match effort {
        "" => None,
        "low" => Some(json!({ "effort": "low" })),
        "medium" => Some(json!({ "effort": "medium" })),
        _ => Some(json!({ "effort": "high" })), // high / xhigh / max / ultra
    }
}

// Shared chat/completions request tail: token cap (api.openai.com rejects max_tokens on current
// models; compat providers expect it) + streaming usage accounting.
pub(super) fn apply_chat_common(out: &mut Value, req: &Value, max_key: &str, base: &str, stream: bool) {
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
pub(super) fn map_chat_tools(tools: &[Value], params_key: &str, filter: fn(&Value) -> bool) -> Option<Value> {
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


// Anthropic Messages request → OpenAI chat/completions request.
fn to_openai_request(req: &Value, base: &str, stream: bool, effort: &str) -> Value {
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

    for m in as_slice(req.get("messages")) {
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
    if base.contains("openrouter.ai") {
        if let Some(reasoning) = to_openrouter_reasoning(effort) {
            out["reasoning"] = reasoning;
        }
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

pub(super) fn map_stop(finish: Option<&str>) -> &'static str {
    match finish {
        Some("tool_calls") => "tool_use",
        Some("length") => "max_tokens",
        _ => "end_turn",
    }
}

// Reasoning delta/field from an OpenAI-compatible payload (DeepSeek streams `reasoning_content`;
// OpenRouter normalizes it to `reasoning`).
pub(super) fn reasoning_text(v: &Value) -> Option<&str> {
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
    for tc in as_slice(msg.and_then(|m| m.get("tool_calls"))) {
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


// ---- streaming translation (OpenAI SSE chunks → Anthropic SSE events) ----


// Block bookkeeping for stream_response: at most one open block at a time (thinking, text, or
// the current tool call).
#[derive(Clone, Copy, PartialEq)]
enum Blk {
    Think,
    Text,
    Tool,
}

// Close the open block if it's a different kind, then open a `kind` block (with the given
// content_block payload) if none is open. Returns the open block's index.
async fn ensure_block(
    w: &mut SseWriter<'_>,
    open: &mut Option<(u64, Blk)>,
    next_index: &mut u64,
    kind: Blk,
    content_block: Value,
) -> std::io::Result<u64> {
    if let Some((idx, k)) = *open {
        if k != kind {
            w.event("content_block_stop", json!({ "type": "content_block_stop", "index": idx })).await?;
            *open = None;
        }
    }
    if open.is_none() {
        w.event(
            "content_block_start",
            json!({ "type": "content_block_start", "index": *next_index, "content_block": content_block }),
        )
        .await?;
        *open = Some((*next_index, kind));
        *next_index += 1;
    }
    Ok(open.unwrap().0)
}

async fn stream_response(sock: &mut TcpStream, upstream: reqwest::Response, model: &str) -> std::io::Result<()> {
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
    )
    .await?;

    let mut w = SseWriter { sock, seq: None };
    w.event(
        "message_start",
        json!({
            "type": "message_start",
            "message": {
                "id": "msg_gateway", "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": { "input_tokens": 0, "output_tokens": 0 },
            },
        }),
    )
    .await?;

    let mut next_index: u64 = 0;
    let mut open: Option<(u64, Blk)> = None;
    let mut tool_blocks: std::collections::HashMap<u64, u64> = std::collections::HashMap::new(); // openai tc index → block index
    let mut finish: Option<String> = None;
    let mut usage: (u64, u64) = (0, 0);

    let mut buf: Vec<u8> = Vec::new();
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
                    w.event("content_block_stop", json!({ "type": "content_block_stop", "index": idx })).await?;
                }
                w.event("error", json!({ "type": "error", "error": { "type": "api_error", "message": msg } })).await?;
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
                let idx = ensure_block(&mut w, &mut open, &mut next_index, Blk::Think, json!({ "type": "thinking", "thinking": "" })).await?;
                w.event(
                    "content_block_delta",
                    json!({ "type": "content_block_delta", "index": idx, "delta": { "type": "thinking_delta", "thinking": t } }),
                )
                .await?;
            }

            // Text delta → ensure a text block is open.
            if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    let idx = ensure_block(&mut w, &mut open, &mut next_index, Blk::Text, json!({ "type": "text", "text": "" })).await?;
                    w.event(
                        "content_block_delta",
                        json!({ "type": "content_block_delta", "index": idx, "delta": { "type": "text_delta", "text": text } }),
                    )
                    .await?;
                }
            }

            // Tool-call deltas: a new id/name opens a tool_use block; argument fragments stream as input_json_delta.
            for tc in as_slice(delta.get("tool_calls")) {
                let tc_index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                if !tool_blocks.contains_key(&tc_index) {
                    if let Some((idx, _)) = open {
                        w.event("content_block_stop", json!({ "type": "content_block_stop", "index": idx })).await?;
                    }
                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("call_gateway");
                    let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("");
                    w.event(
                        "content_block_start",
                        json!({
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
                            json!({ "type": "content_block_delta", "index": idx, "delta": { "type": "input_json_delta", "partial_json": args } }),
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
        w.event("content_block_stop", json!({ "type": "content_block_stop", "index": idx })).await?;
    }
    // Upstream produced nothing at all (no content, no finish reason) — an empty assistant
    // message would make the CLI retry forever, so fail the request loudly instead.
    if next_index == 0 && finish.is_none() {
        w.event(
            "error",
            json!({ "type": "error", "error": { "type": "api_error", "message": "upstream returned an empty response" } }),
        )
        .await?;
        return w.sock.flush().await;
    }
    w.event(
        "message_delta",
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": map_stop(finish.as_deref()), "stop_sequence": null },
            "usage": { "input_tokens": usage.0, "output_tokens": usage.1 },
        }),
    )
    .await?;
    w.event("message_stop", json!({ "type": "message_stop" })).await?;
    w.sock.flush().await
}
