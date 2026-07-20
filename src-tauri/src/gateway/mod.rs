// gateway/ — a per-run local HTTP proxy that lets any agentic CLI harness drive any model
// endpoint. It accepts the protocol the CLI speaks (`inbound`) on 127.0.0.1:<random port> and
// forwards to the target endpoint's protocol (`outbound`):
//
//   inbound   outbound   handling
//   anthropic openai     translate Messages API ⇄ chat/completions (streaming SSE included)
//   anthropic anthropic  transparent passthrough
//   openai    openai     passthrough; /v1/responses additionally ⇄ chat/completions
//   openai    anthropic  translate chat/completions and /responses ⇄ Messages API
//
// Security: the listener binds loopback only; every request must carry the per-run random
// token (Authorization: Bearer / x-api-key), so other local processes can't relay through
// the stored provider key. The provider key itself never reaches the CLI process.
use rand::RngCore;
use tokio::net::TcpListener;

mod anthropic_openai;
mod http;
mod openai_anthropic;
mod responses;
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
    pub effort: String,      // Reasoning depth the user picked in the app
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
                let _ = http::handle_conn(sock, &cfg, &tok).await;
            });
        }
    });
    Ok(Gateway { port, token, handle })
}


#[cfg(test)]
mod tests {
    use super::anthropic_openai::{map_stop, to_openrouter_reasoning, tool_result_text};
    use super::http::read_request;
    use super::openai_anthropic::{chat_to_anthropic, responses_to_anthropic};
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn tool_result_text_flattens_string_and_array_content() {
        assert_eq!(tool_result_text(Some(&json!("plain"))), "plain");
        let arr = json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }]);
        assert_eq!(tool_result_text(Some(&arr)), "ab");
        assert_eq!(tool_result_text(None), "");
        assert_eq!(tool_result_text(Some(&json!(42))), ""); // non-text → empty
    }

    // Reasoning is opt-in: it rides the level the user picked in the app, never the CLI's request.
    // Probe-verified why — `claude` with no --effort still sends output_config.effort "xhigh" and
    // thinking:{type:"adaptive"}, so reading the body would bill every routed run for reasoning.
    #[test]
    fn openrouter_reasoning_follows_the_picked_level() {
        assert_eq!(to_openrouter_reasoning("low"), Some(json!({ "effort": "low" })));
        assert_eq!(to_openrouter_reasoning("medium"), Some(json!({ "effort": "medium" })));
        // OpenRouter tops out at high — the Anthropic-only levels clamp instead of erroring.
        for lvl in ["high", "xhigh", "max"] {
            assert_eq!(to_openrouter_reasoning(lvl), Some(json!({ "effort": "high" })), "{lvl}");
        }
    }

    #[test]
    fn openrouter_reasoning_absent_on_auto() {
        assert_eq!(to_openrouter_reasoning(""), None);
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
            effort: String::new(),
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
            effort: String::new(),
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
            effort: String::new(),
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
            effort: String::new(),
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
            effort: String::new(),
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
            effort: String::new(),
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
        // Finalization contract: text + tool items are closed (in order) before response.completed,
        // which carries the assembled output and full usage.
        assert!(resp.contains("event: response.output_text.done"), "no text done: {resp}");
        assert!(resp.contains("event: response.output_item.done"), "no item done: {resp}");
        assert!(resp.contains(r#""text":"hello""#), "final text lost: {resp}");
        assert!(resp.contains(r#""status":"completed""#), "no completed status: {resp}");
        assert!(resp.contains(r#""total_tokens":7"#), "total lost: {resp}");
        let args_done = resp.find("event: response.function_call_arguments.done").unwrap();
        let last_item_done = resp.rfind("event: response.output_item.done").unwrap();
        let completed = resp.find("event: response.completed").unwrap();
        assert!(args_done < last_item_done && last_item_done < completed, "finalization out of order: {resp}");
    }

    // No text and no tool call → response.failed with the tool-capability hint, not a silent empty turn.
    #[tokio::test]
    async fn responses_empty_stream_fails_loudly() {
        let upstream = sse("data: [DONE]\n\n");
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = start(GatewayConfig {
            inbound: Proto::OpenAi,
            outbound: Proto::OpenAi,
            target_base: format!("http://127.0.0.1:{}", port),
            api_key: "k".into(),
            effort: String::new(),
        })
        .await
        .unwrap();

        let resp = roundtrip(&gw, "/v1/responses", r#"{"model":"m","stream":true,"input":"hi"}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: response.failed"), "no failed event: {resp}");
        assert!(resp.contains("may not support tool calling"), "hint lost: {resp}");
        assert!(!resp.contains("response.completed"), "completed still emitted: {resp}");
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
            effort: String::new(),
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
            effort: String::new(),
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
        // Finalization contract (mirror of the chat→responses path): items closed before
        // response.completed; usage totals computed input+output.
        assert!(resp.contains("event: response.output_item.done"), "no item done: {resp}");
        assert!(resp.contains(r#""summary_text""#), "reasoning summary lost: {resp}");
        assert!(resp.contains(r#""status":"completed""#), "no completed status: {resp}");
        assert!(resp.contains(r#""output_tokens":7"#), "output tokens lost: {resp}");
        assert!(resp.contains(r#""total_tokens":12"#), "computed total lost: {resp}");
        let args_done = resp.find("event: response.function_call_arguments.done").unwrap();
        let last_item_done = resp.rfind("event: response.output_item.done").unwrap();
        let completed = resp.find("event: response.completed").unwrap();
        assert!(args_done < last_item_done && last_item_done < completed, "finalization out of order: {resp}");
    }

    // Anthropic upstream that produces neither text nor a tool call → response.failed (shorter
    // message than the chat→responses path — no tool-capability hint here).
    #[tokio::test]
    async fn anthropic_responses_empty_stream_fails_loudly() {
        let upstream = sse(concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ));
        let port = mock_upstream(Box::leak(upstream.into_boxed_str())).await;
        let gw = anthropic_gw(port, Proto::OpenAi).await;

        let resp = roundtrip(&gw, "/v1/responses", r#"{"model":"m","stream":true,"input":"hi"}"#).await;
        gw.shutdown();
        assert!(resp.contains("event: response.failed"), "no failed event: {resp}");
        assert!(resp.contains("the model returned no content"), "message lost: {resp}");
        assert!(!resp.contains("response.completed"), "completed still emitted: {resp}");
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
            effort: String::new(),
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
