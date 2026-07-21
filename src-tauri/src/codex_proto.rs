// codex_proto.rs — line builders + stdout classifier for the codex `app-server` protocol
// (JSON-RPC-ish over JSONL: requests {id,method,params}, responses {id,result|error},
// notifications {method,params}; NO "jsonrpc" field, no LSP framing). All shapes probe-verified
// against codex-cli 0.142.5 — the codex analog of the claude
// 2.1.206 stdio control protocol session.rs speaks. Rust owns lifecycle lines (handshake,
// thread/turn start, interrupt); every stdout line is still forwarded raw to TS for decoding.
use serde_json::json;

// Modelius permission mode → codex-native (approvalPolicy, thread/start sandbox mode,
// turn/start SandboxPolicy object). No Claude emulation: plan explores read-only and surfaces
// escalations as approval cards; default/acceptEdits auto-allow workspace writes via the sandbox
// (escalations still ask); bypass = codex's own danger-full-access + never.
pub(crate) fn codex_mode(mode: &str) -> (&'static str, &'static str, serde_json::Value) {
    match mode {
        "plan" => ("on-request", "read-only", json!({ "type": "readOnly" })),
        "bypassPermissions" => ("never", "danger-full-access", json!({ "type": "dangerFullAccess" })),
        _ => ("on-request", "workspace-write", json!({ "type": "workspaceWrite" })),
    }
}

pub(crate) fn initialize_line(id: u64) -> String {
    json!({
        "id": id,
        "method": "initialize",
        "params": { "clientInfo": { "name": "modelius", "version": env!("CARGO_PKG_VERSION") } }
    })
    .to_string()
}

pub(crate) fn initialized_line() -> String {
    json!({ "method": "initialized" }).to_string()
}

// thread/start (fresh) or thread/resume (prior thread id from metadata.sessionId — the rollout
// store is shared with the old `codex exec` path, so exec-era ids resume here too).
pub(crate) fn thread_open_line(id: u64, resume: Option<&str>, model: &str, cwd: &str, mode: &str) -> String {
    let (approval, sandbox, _) = codex_mode(mode);
    let mut params = json!({ "cwd": cwd, "approvalPolicy": approval, "sandbox": sandbox });
    if !model.is_empty() {
        params["model"] = json!(model);
    }
    let method = match resume {
        Some(tid) => {
            params["threadId"] = json!(tid);
            "thread/resume"
        }
        None => "thread/start",
    };
    json!({ "id": id, "method": method, "params": params }).to_string()
}

// One user turn. model/effort/approvalPolicy/sandboxPolicy are per-turn overrides that "stick for
// this turn and subsequent turns" — re-asserting the mode each turn makes an in-session permission
// switch free (the codex analog of claude's set_permission_mode), and effort changes never respawn.
// Attached images ride the `input` array as `{type:"image", image_url}` items with an inline data
// URL — the app-server InputItem shape (remote HTTP urls are rejected; a data URL is accepted).
pub(crate) fn turn_start_line(id: u64, thread_id: &str, text: &str, images: &[crate::agent::ImageInput], model: &str, effort: &str, mode: &str) -> String {
    let (approval, _, sandbox_policy) = codex_mode(mode);
    let mut input = Vec::new();
    // Omit an empty text item when an image carries the turn; keep it otherwise so input is never empty.
    if !text.is_empty() || images.is_empty() {
        input.push(json!({ "type": "text", "text": text }));
    }
    for im in images {
        input.push(json!({ "type": "image", "image_url": format!("data:{};base64,{}", im.mime, im.data) }));
    }
    let mut params = json!({
        "threadId": thread_id,
        "input": input,
        "approvalPolicy": approval,
        "sandboxPolicy": sandbox_policy,
    });
    if !model.is_empty() {
        params["model"] = json!(model);
    }
    if !effort.is_empty() {
        params["effort"] = json!(effort);
    }
    json!({ "id": id, "method": "turn/start", "params": params }).to_string()
}

pub(crate) fn turn_interrupt_line(id: u64, thread_id: &str, turn_id: &str) -> String {
    json!({ "id": id, "method": "turn/interrupt", "params": { "threadId": thread_id, "turnId": turn_id } })
        .to_string()
}

// model/list — the models the connected account can run (subscription-filtered, the same set the
// CLI's `/model` shows). Needs no thread; issued right after the handshake (codex_list_models).
pub(crate) fn model_list_line(id: u64) -> String {
    json!({ "id": id, "method": "model/list", "params": {} }).to_string()
}

// What the pump needs to know about one stdout line. Everything else (deltas, items, approvals,
// token usage) is opaque here — forwarded raw and decoded in TS (codexAppServerTransform.ts).
#[derive(Debug, PartialEq)]
pub(crate) enum CodexLine {
    // turn/started — carries the live turn id (needed for turn/interrupt).
    TurnStarted { thread_id: String, turn_id: String },
    // turn/completed — ends the attached turn, but only when thread_id matches the session's
    // (a sub-agent thread's completion on the same connection must not end the parent turn).
    TurnCompleted { thread_id: String },
    // A response to one of our requests. thread_id is set when the result carries a thread
    // (thread/start | thread/resume responses) — that's where the session learns its thread id.
    RpcResponse { id: u64, thread_id: Option<String> },
    RpcError { id: u64, message: String },
    Other,
}

pub(crate) fn classify(line: &str) -> CodexLine {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return CodexLine::Other,
    };
    let method = v.get("method").and_then(|m| m.as_str());
    let id = v.get("id").and_then(|i| i.as_u64());
    match (method, id) {
        // Server→client requests (approvals) carry BOTH method and id — not ours to answer here;
        // TS answers via agent_respond. Notifications carry method only.
        (Some(m), None) => {
            let p = v.get("params").unwrap_or(&serde_json::Value::Null);
            let thread_id = p.get("threadId").and_then(|t| t.as_str()).unwrap_or("").to_string();
            match m {
                "turn/started" => {
                    let turn_id = p
                        .get("turn")
                        .and_then(|t| t.get("id"))
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    CodexLine::TurnStarted { thread_id, turn_id }
                }
                "turn/completed" => CodexLine::TurnCompleted { thread_id },
                _ => CodexLine::Other,
            }
        }
        (None, Some(id)) => {
            if let Some(err) = v.get("error") {
                let message = err.get("message").and_then(|m| m.as_str()).unwrap_or("request failed").to_string();
                CodexLine::RpcError { id, message }
            } else {
                let thread_id = v
                    .get("result")
                    .and_then(|r| r.get("thread"))
                    .and_then(|t| t.get("id"))
                    .and_then(|i| i.as_str())
                    .map(String::from);
                CodexLine::RpcResponse { id, thread_id }
            }
        }
        _ => CodexLine::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wire contracts, locked against lines captured from codex-cli 0.142.5 (probe script).

    #[test]
    fn codex_mode_maps_modelius_modes_natively() {
        assert_eq!(codex_mode("plan").0, "on-request");
        assert_eq!(codex_mode("plan").1, "read-only");
        assert_eq!(codex_mode("default").1, "workspace-write");
        assert_eq!(codex_mode("acceptEdits").1, "workspace-write");
        let bypass = codex_mode("bypassPermissions");
        assert_eq!(bypass.0, "never");
        assert_eq!(bypass.1, "danger-full-access");
        assert_eq!(bypass.2, serde_json::json!({ "type": "dangerFullAccess" }));
        assert_eq!(codex_mode("").1, codex_mode("default").1); // unset mode = default
    }

    #[test]
    fn handshake_lines_have_no_jsonrpc_field() {
        let init = initialize_line(1);
        let v: serde_json::Value = serde_json::from_str(&init).unwrap();
        assert!(v.get("jsonrpc").is_none()); // codex dialect omits it
        assert_eq!(v["method"], "initialize");
        assert_eq!(v["params"]["clientInfo"]["name"], "modelius");
        assert_eq!(initialized_line(), r#"{"method":"initialized"}"#);
    }

    #[test]
    fn model_list_line_is_a_bare_request() {
        let v: serde_json::Value = serde_json::from_str(&model_list_line(2)).unwrap();
        assert_eq!(v["id"], 2);
        assert_eq!(v["method"], "model/list");
        assert_eq!(v["params"], serde_json::json!({}));
        assert!(v.get("jsonrpc").is_none());
    }

    #[test]
    fn thread_open_picks_start_or_resume() {
        let start: serde_json::Value =
            serde_json::from_str(&thread_open_line(2, None, "gpt-5.5", "D:\\proj", "plan")).unwrap();
        assert_eq!(start["method"], "thread/start");
        assert_eq!(start["params"]["approvalPolicy"], "on-request");
        assert_eq!(start["params"]["sandbox"], "read-only");
        assert_eq!(start["params"]["model"], "gpt-5.5");
        assert!(start["params"].get("threadId").is_none());

        let resume: serde_json::Value =
            serde_json::from_str(&thread_open_line(2, Some("t-1"), "", "D:\\proj", "default")).unwrap();
        assert_eq!(resume["method"], "thread/resume");
        assert_eq!(resume["params"]["threadId"], "t-1");
        assert!(resume["params"].get("model").is_none()); // no model picked → thread default
    }

    #[test]
    fn turn_start_carries_per_turn_overrides() {
        let v: serde_json::Value =
            serde_json::from_str(&turn_start_line(5, "t-1", "do it", &[], "gpt-5.5", "high", "acceptEdits")).unwrap();
        assert_eq!(v["method"], "turn/start");
        assert_eq!(v["params"]["threadId"], "t-1");
        assert_eq!(v["params"]["input"], serde_json::json!([{ "type": "text", "text": "do it" }]));
        assert_eq!(v["params"]["effort"], "high");
        assert_eq!(v["params"]["approvalPolicy"], "on-request");
        assert_eq!(v["params"]["sandboxPolicy"], serde_json::json!({ "type": "workspaceWrite" }));
        // empty effort/model are omitted, not sent as ""
        let bare: serde_json::Value =
            serde_json::from_str(&turn_start_line(5, "t-1", "hi", &[], "", "", "default")).unwrap();
        assert!(bare["params"].get("effort").is_none());
        assert!(bare["params"].get("model").is_none());
    }

    #[test]
    fn turn_start_appends_image_items_as_data_urls() {
        let imgs = [crate::agent::ImageInput { mime: "image/png".into(), data: "QUJD".into() }];
        let v: serde_json::Value =
            serde_json::from_str(&turn_start_line(5, "t-1", "look", &imgs, "", "", "default")).unwrap();
        assert_eq!(
            v["params"]["input"],
            serde_json::json!([
                { "type": "text", "text": "look" },
                { "type": "image", "image_url": "data:image/png;base64,QUJD" }
            ])
        );
        // image with no text → just the image item (no empty text block)
        let only: serde_json::Value =
            serde_json::from_str(&turn_start_line(5, "t-1", "", &imgs, "", "", "default")).unwrap();
        assert_eq!(
            only["params"]["input"],
            serde_json::json!([{ "type": "image", "image_url": "data:image/png;base64,QUJD" }])
        );
    }

    #[test]
    fn classify_matches_probe_captured_lines() {
        // turn/started (captured 0.142.5)
        let started = r#"{"method":"turn/started","params":{"threadId":"th-1","turn":{"id":"tu-1","items":[],"status":"inProgress"}}}"#;
        assert_eq!(
            classify(started),
            CodexLine::TurnStarted { thread_id: "th-1".into(), turn_id: "tu-1".into() }
        );
        // turn/completed ends the turn — foreign thread ids must NOT (sub-agent guard)
        let completed = r#"{"method":"turn/completed","params":{"threadId":"th-1","turn":{"id":"tu-1","status":"interrupted"}}}"#;
        assert_eq!(classify(completed), CodexLine::TurnCompleted { thread_id: "th-1".into() });
        // thread/start response carries the thread id
        let resp = r#"{"id":2,"result":{"thread":{"id":"th-1","sessionId":"th-1"},"model":"gpt-5.5"}}"#;
        assert_eq!(classify(resp), CodexLine::RpcResponse { id: 2, thread_id: Some("th-1".into()) });
        // plain response (initialize / turn/interrupt ack)
        assert_eq!(classify(r#"{"id":4,"result":{}}"#), CodexLine::RpcResponse { id: 4, thread_id: None });
        // error response
        assert_eq!(
            classify(r#"{"id":3,"error":{"code":-32600,"message":"bad params"}}"#),
            CodexLine::RpcError { id: 3, message: "bad params".into() }
        );
        // server REQUEST (approval): method + id — must be Other here (TS answers it)
        let approval = r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"th-1","turnId":"tu-1","itemId":"call_1"}}"#;
        assert_eq!(classify(approval), CodexLine::Other);
        // notifications we don't track
        assert_eq!(classify(r#"{"method":"item/agentMessage/delta","params":{"delta":"H"}}"#), CodexLine::Other);
        assert_eq!(classify("not json"), CodexLine::Other);
    }
}
