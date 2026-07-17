use super::anthropic_openai::{apply_chat_common, map_chat_tools, reasoning_text};
use super::http::{as_slice, drain_sse, err_body, respond_json, respond_translated, send_chat, upstream_error, SseWriter};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

// ---- /responses: translate the OpenAI Responses API ⇄ chat/completions ----
//
// Codex only speaks the Responses API. We forward its requests onto the target endpoint's
// chat/completions (the protocol every bound provider serves) and translate the answer back into
// Responses events / objects. Mirrors the anthropic path above, one API shape over.

pub(super) async fn proxy_responses(sock: &mut TcpStream, base: &str, key: &str, body: &[u8]) -> std::io::Result<()> {
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
    for (i, tc) in as_slice(msg.and_then(|m| m.get("tool_calls"))).iter().enumerate() {
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

// Flush accumulated upstream reasoning as one completed Responses reasoning item (summary_text).
// Called when the model moves on to text/tool output (and at stream end), so codex sees the
// reasoning item before whatever follows it.
pub(super) async fn flush_reasoning(
    w: &mut SseWriter<'_>,
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
pub(super) struct RespToolAcc {
    pub(super) output_index: u64,
    pub(super) item_id: String,
    pub(super) call_id: String,
    pub(super) name: String,
    pub(super) args: String,
}

// Finalization shared by both Responses-SSE producers (chat upstream / anthropic upstream):
// close the open text item and every accumulated tool item (in emit order), assemble the
// completed response.output ordered by output_index, and emit response.completed — or
// response.failed with `empty_msg` when the stream produced neither text nor a tool call
// (reasoning alone doesn't count; silently completing an empty turn shows the user "no answer").
pub(super) async fn finalize_responses_stream(
    w: &mut SseWriter<'_>,
    mut final_items: Vec<(u64, Value)>, // flushed reasoning items
    text: Option<(u64, String)>,        // (output_index, accumulated text) when a message item is open
    tools: std::collections::HashMap<u64, RespToolAcc>,
    tool_order: Vec<u64>,
    model: &str,
    usage: (u64, u64, u64), // (input, output, total)
    empty_msg: &str,
) -> std::io::Result<()> {
    let text_item_id = "msg_0";
    let has_text = text.is_some();
    if let Some((text_oi, text_buf)) = text {
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

    if !has_text && tool_order.is_empty() {
        w.event(
            "response.failed",
            json!({ "type": "response.failed", "response": { "id": "resp_gateway", "status": "failed",
                "error": { "message": empty_msg } } }),
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

// ---- streaming translation (OpenAI SSE chunks → Responses SSE events) ----
async fn stream_responses(sock: &mut TcpStream, upstream: reqwest::Response, model: &str) -> std::io::Result<()> {
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

    let mut buf: Vec<u8> = Vec::new();
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
            for tc in as_slice(delta.get("tool_calls")) {
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

    // A common cause of the empty-turn failure here: the picked model can't do tool calling,
    // which Codex always requests.
    finalize_responses_stream(
        &mut w,
        think_items,
        text_open.then_some((text_oi, text_buf)),
        tools,
        tool_order,
        model,
        usage,
        "the model returned no content — it may not support tool calling; try a tool-capable model",
    )
    .await
}
