use super::anthropic_openai::tool_result_text;
use super::http::{as_slice, drain_sse, err_body, respond_json, respond_translated, send_messages, SseWriter};
use super::responses::{finalize_responses_stream, flush_reasoning, RespToolAcc};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

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
pub(super) fn chat_to_anthropic(req: &Value) -> Value {
    let mut system = String::new();
    let mut messages: Vec<Value> = Vec::new();

    for m in as_slice(req.get("messages")) {
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
                for tc in as_slice(m.get("tool_calls")) {
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
pub(super) fn responses_to_anthropic(req: &Value) -> Value {
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
                            // tool_result_text flattens the same string-or-text-parts shape.
                            let text = tool_result_text(it.get("content"));
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


// Anthropic non-stream Messages response → OpenAI chat/completions response.
fn anthropic_to_chat(j: &Value, model: &str) -> Value {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    for block in as_slice(j.get("content")) {
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
    for block in as_slice(j.get("content")) {
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

pub(super) async fn proxy_chat_to_anthropic(sock: &mut TcpStream, base: &str, key: &str, headers_in: &[(String, String)], body: &[u8]) -> std::io::Result<()> {
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

pub(super) async fn proxy_responses_to_anthropic(sock: &mut TcpStream, base: &str, key: &str, headers_in: &[(String, String)], body: &[u8]) -> std::io::Result<()> {
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

    let mut buf: Vec<u8> = Vec::new();
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

    let mut w = SseWriter { sock, seq: Some(0) };
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

    let mut buf: Vec<u8> = Vec::new();
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

    finalize_responses_stream(
        &mut w,
        think_items,
        text_open.then_some((text_oi, text_buf)),
        tools,
        tool_order,
        model,
        (usage.0, usage.1, usage.0 + usage.1),
        "the model returned no content",
    )
    .await
}
