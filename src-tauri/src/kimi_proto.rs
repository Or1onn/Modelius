// kimi_proto.rs — line builders + stdout classifier for `kimi acp` (Agent Client Protocol,
// strict JSON-RPC 2.0 over JSONL). All shapes probe-verified against @moonshot-ai/kimi-code
// 0.25.0 — the kimi analog of codex_proto.rs. Key dialect difference:
// every line MUST carry "jsonrpc":"2.0" (the ACP SDK ignores messages without it). Rust owns
// lifecycle lines (initialize, session open, prompt, cancel, set_model/set_mode); every stdout
// line is still forwarded raw to TS for decoding (kimiAcpTransform.ts).
use serde_json::json;

// Modelius permission mode → kimi ACP session mode id. Probe-verified mode set:
// default ("Manual approvals") / plan ("Read-only planning") / auto ("Auto-approve safe
// operations") / yolo ("Auto-approve everything").
pub(crate) fn kimi_mode(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "acceptEdits" => "auto",
        "bypassPermissions" => "yolo",
        _ => "default",
    }
}

pub(crate) fn initialize_line(id: u64) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            // fs/terminal declared unsupported: the agent then uses its own file access and
            // never routes fs/* or terminal/* server requests at the client.
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            },
            "clientInfo": { "name": "modelius", "version": env!("CARGO_PKG_VERSION") }
        }
    })
    .to_string()
}

// session/new (fresh) or session/resume (prior session id from metadata.sessionId). Per ACP,
// resume — unlike session/load — replays NO history notifications, which fits Modelius: the
// webview keeps its own transcript and would only duplicate a replay.
pub(crate) fn session_open_line(id: u64, resume: Option<&str>, cwd: &str) -> String {
    let mut params = json!({ "cwd": cwd, "mcpServers": [] });
    let method = match resume {
        Some(sid) => {
            params["sessionId"] = json!(sid);
            "session/resume"
        }
        None => "session/new",
    };
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

// Attached images ride the `prompt` ContentBlock array as ACP `{type:"image", mimeType, data}`
// blocks (base64). Per ACP the agent must advertise the `image` prompt capability at initialize;
// kimi's support for that is GUI-verify-pending, so image blocks are only appended when the user
// actually attaches one (text-only turns are byte-identical to before).
pub(crate) fn prompt_line(id: u64, session_id: &str, text: &str, images: &[crate::agent::ImageInput]) -> String {
    let mut prompt = Vec::new();
    // Omit an empty text block when an image carries the turn; keep it otherwise so prompt is never empty.
    if !text.is_empty() || images.is_empty() {
        prompt.push(json!({ "type": "text", "text": text }));
    }
    for im in images {
        prompt.push(json!({ "type": "image", "mimeType": im.mime, "data": im.data }));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": { "sessionId": session_id, "prompt": prompt }
    })
    .to_string()
}

// Notification (no id, never answered): halts the running turn; the pending session/prompt then
// resolves normally with stopReason "cancelled" and the session stays usable (probe P6).
pub(crate) fn cancel_line(session_id: &str) -> String {
    json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session_id } }).to_string()
}

// ACP has no working spawn-time model flag (probe P8: a root-level -m is parsed but not bound to
// the acp session) — the model is set in-session right after the session opens, before the first
// prompt. The ack ({}) is swallowed by the pump.
pub(crate) fn set_model_line(id: u64, session_id: &str, model_id: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_model",
        "params": { "sessionId": session_id, "modelId": model_id }
    })
    .to_string()
}

// In-session permission-mode switch (the kimi analog of claude's set_permission_mode). A fresh
// acp session always boots in "default" mode regardless of argv, so begin_turn reconciles.
pub(crate) fn set_mode_line(id: u64, session_id: &str, mode_id: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_mode",
        "params": { "sessionId": session_id, "modeId": mode_id }
    })
    .to_string()
}

// What the pump needs to know about one stdout line. Everything else (message/thought chunks,
// tool calls, permission requests) is opaque here — forwarded raw and decoded in TS.
#[derive(Debug, PartialEq)]
pub(crate) enum KimiLine {
    // A response to one of our requests. session_id is set when the result carries one (the
    // session/new response) — session/resume responses carry only configOptions, the caller
    // already knows the id it asked to resume.
    Response { id: u64, session_id: Option<String> },
    // code kept: -32000 = authRequired (drives the "run `kimi login`" hint).
    Error { id: u64, code: i64, message: String },
    // Notifications AND server requests (method+id, e.g. session/request_permission) — forwarded;
    // TS decodes notifications and answers server requests via agent_respond.
    Other,
}

pub(crate) fn classify(line: &str) -> KimiLine {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return KimiLine::Other,
    };
    let method = v.get("method").and_then(|m| m.as_str());
    let id = v.get("id").and_then(|i| i.as_u64());
    match (method, id) {
        // (Some, Some) = server request (TS answers), (Some, None) = notification: both Other.
        (None, Some(id)) => {
            if let Some(err) = v.get("error") {
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                let mut message = err.get("message").and_then(|m| m.as_str()).unwrap_or("request failed").to_string();
                // The actionable text often hides in data.details (e.g. -32603 "Internal error"
                // with details 'Model "x" is not configured in config.toml…') — surface it.
                if let Some(details) = err.get("data").and_then(|d| d.get("details")).and_then(|s| s.as_str()) {
                    if !details.is_empty() {
                        message = format!("{}: {}", message, details);
                    }
                }
                KimiLine::Error { id, code, message }
            } else {
                let session_id = v
                    .get("result")
                    .and_then(|r| r.get("sessionId"))
                    .and_then(|s| s.as_str())
                    .map(String::from);
                KimiLine::Response { id, session_id }
            }
        }
        _ => KimiLine::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wire contracts, locked against lines captured from @moonshot-ai/kimi-code 0.25.0 (probe).

    #[test]
    fn kimi_mode_maps_modelius_modes_to_acp_mode_ids() {
        assert_eq!(kimi_mode("plan"), "plan");
        assert_eq!(kimi_mode("acceptEdits"), "auto");
        assert_eq!(kimi_mode("bypassPermissions"), "yolo");
        assert_eq!(kimi_mode("default"), "default");
        assert_eq!(kimi_mode(""), "default");
    }

    #[test]
    fn every_builder_carries_jsonrpc_2_0() {
        // The inverse of codex_proto's handshake_lines_have_no_jsonrpc_field: the ACP SDK
        // silently drops messages missing the field, so a regression here is a hang.
        for line in [
            initialize_line(1),
            session_open_line(2, None, "D:\\proj"),
            session_open_line(2, Some("session_x"), "D:\\proj"),
            prompt_line(3, "session_x", "hi", &[]),
            cancel_line("session_x"),
            set_model_line(4, "session_x", "kimi-k2.7-code"),
            set_mode_line(5, "session_x", "yolo"),
        ] {
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["jsonrpc"], "2.0", "missing jsonrpc in {}", line);
        }
    }

    #[test]
    fn initialize_declares_no_fs_or_terminal_capabilities() {
        let v: serde_json::Value = serde_json::from_str(&initialize_line(1)).unwrap();
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["protocolVersion"], 1);
        assert_eq!(v["params"]["clientCapabilities"]["fs"]["readTextFile"], false);
        assert_eq!(v["params"]["clientCapabilities"]["fs"]["writeTextFile"], false);
        assert_eq!(v["params"]["clientCapabilities"]["terminal"], false);
    }

    #[test]
    fn session_open_picks_new_or_resume() {
        let fresh: serde_json::Value = serde_json::from_str(&session_open_line(2, None, "D:\\proj")).unwrap();
        assert_eq!(fresh["method"], "session/new");
        assert_eq!(fresh["params"]["cwd"], "D:\\proj");
        assert_eq!(fresh["params"]["mcpServers"], serde_json::json!([]));
        assert!(fresh["params"].get("sessionId").is_none());

        let resume: serde_json::Value =
            serde_json::from_str(&session_open_line(2, Some("session_a"), "D:\\proj")).unwrap();
        assert_eq!(resume["method"], "session/resume");
        assert_eq!(resume["params"]["sessionId"], "session_a");
    }

    #[test]
    fn prompt_line_wraps_text_in_a_content_block() {
        let v: serde_json::Value = serde_json::from_str(&prompt_line(3, "session_a", "do it", &[])).unwrap();
        assert_eq!(v["method"], "session/prompt");
        assert_eq!(v["params"]["sessionId"], "session_a");
        assert_eq!(v["params"]["prompt"], serde_json::json!([{ "type": "text", "text": "do it" }]));
    }

    #[test]
    fn prompt_line_appends_image_content_blocks() {
        let imgs = [crate::agent::ImageInput { mime: "image/jpeg".into(), data: "QUJD".into() }];
        let v: serde_json::Value = serde_json::from_str(&prompt_line(3, "session_a", "look", &imgs)).unwrap();
        assert_eq!(
            v["params"]["prompt"],
            serde_json::json!([
                { "type": "text", "text": "look" },
                { "type": "image", "mimeType": "image/jpeg", "data": "QUJD" }
            ])
        );
        // image with no text → just the image block (no empty text block)
        let only: serde_json::Value = serde_json::from_str(&prompt_line(3, "session_a", "", &imgs)).unwrap();
        assert_eq!(
            only["params"]["prompt"],
            serde_json::json!([{ "type": "image", "mimeType": "image/jpeg", "data": "QUJD" }])
        );
    }

    #[test]
    fn cancel_is_a_notification_without_id() {
        let v: serde_json::Value = serde_json::from_str(&cancel_line("session_a")).unwrap();
        assert_eq!(v["method"], "session/cancel");
        assert!(v.get("id").is_none());
    }

    #[test]
    fn classify_matches_probe_captured_lines() {
        // session/new response carries the session id (captured 0.25.0)
        let new_resp = r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"session_b4524113","configOptions":[]}}"#;
        assert_eq!(
            classify(new_resp),
            KimiLine::Response { id: 2, session_id: Some("session_b4524113".into()) }
        );
        // session/resume response has no sessionId — plain response
        let resume_resp = r#"{"jsonrpc":"2.0","id":2,"result":{"configOptions":[]}}"#;
        assert_eq!(classify(resume_resp), KimiLine::Response { id: 2, session_id: None });
        // prompt response (turn end) — sessionId absent
        let prompt_resp = r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#;
        assert_eq!(classify(prompt_resp), KimiLine::Response { id: 3, session_id: None });
        // authRequired error (captured: unauthenticated session/new)
        let auth_err = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}"#;
        assert_eq!(
            classify(auth_err),
            KimiLine::Error { id: 2, code: -32000, message: "Authentication required".into() }
        );
        // data.details carries the actionable text (captured: set_model with an unknown model
        // on an account whose login populated no model catalog)
        let details_err = r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32603,"message":"Internal error","data":{"details":"Model \"kimi-k2.7-code\" is not configured in config.toml. Add a [models.\"kimi-k2.7-code\"] entry with max_context_size."}}}"#;
        match classify(details_err) {
            KimiLine::Error { id, code, message } => {
                assert_eq!((id, code), (4, -32603));
                assert!(message.starts_with("Internal error: Model"));
                assert!(message.contains("not configured in config.toml"));
            }
            other => panic!("expected Error, got {:?}", other),
        }
        // notification → Other (forwarded to TS)
        let chunk = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"H"}}}}"#;
        assert_eq!(classify(chunk), KimiLine::Other);
        // server REQUEST (permission): method + id — must be Other here (TS answers it)
        let perm = r#"{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"s","options":[],"toolCall":{}}}"#;
        assert_eq!(classify(perm), KimiLine::Other);
        assert_eq!(classify("not json"), KimiLine::Other);
    }
}
