import type { UIMessageChunk } from "./uiMessageChunk";

// Codex `exec --json` JSONL → AI SDK UIMessageChunk. Unlike Claude, Codex emits whole items (no
// token deltas), so text/reasoning are emitted as a single start+delta+end. Tool names are emitted
// canonical (Bash/Read/Edit/…) so the shared renderer + tool registry handle Claude and Codex
// uniformly. Mirrors the Rust parser that used to live in agent.rs handle_codex_line.
export function createCodexTransformer() {
  let started = false;
  let startTime: number | null = null;
  let threadId: string | undefined;
  const startedTools = new Set<string>(); // command/mcp items whose call was already emitted
  const genId = () => `cx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  function* emitText(text: string): Generator<UIMessageChunk> {
    const id = genId();
    yield { type: "text-start", id };
    yield { type: "text-delta", id, delta: text };
    yield { type: "text-end", id };
  }

  function meta(subtype: string) {
    return {
      sessionId: threadId,
      resultSubtype: subtype,
      durationMs: startTime ? Date.now() - startTime : undefined,
    };
  }

  return function* transform(msg: any): Generator<UIMessageChunk> {
    if (!started) {
      started = true;
      startTime = Date.now();
      yield { type: "start" };
      yield { type: "start-step" };
    }

    switch (msg?.type) {
      case "thread.started":
        if (typeof msg.thread_id === "string") threadId = msg.thread_id;
        return;

      case "turn.completed": {
        const u = (k: string): number => msg?.usage?.[k] ?? 0;
        const m = {
          ...meta("success"),
          inputTokens: u("input_tokens"),
          outputTokens: u("output_tokens"),
          totalTokens: u("input_tokens") + u("cached_input_tokens") || undefined,
        };
        yield { type: "message-metadata", messageMetadata: m };
        yield { type: "finish-step" };
        yield { type: "finish", messageMetadata: m };
        return;
      }

      case "turn.failed":
        yield { type: "error", errorText: msg?.error?.message ?? "turn failed" };
        yield { type: "finish", messageMetadata: meta("error") };
        return;

      case "error":
        yield { type: "error", errorText: msg?.message ?? "stream error" };
        yield { type: "finish", messageMetadata: meta("error") };
        return;

      case "item.started":
      case "item.completed": {
        const item = msg?.item ?? {};
        const completed = msg.type === "item.completed";
        const id = String(item.id ?? genId());
        const get = (k: string): string => (typeof item[k] === "string" ? item[k] : "");

        switch (item.type) {
          case "agent_message":
            if (completed && get("text").trim()) yield* emitText(get("text"));
            return;

          case "reasoning":
            if (completed && get("text").trim()) {
              const tid = genId();
              yield { type: "tool-input-available", toolCallId: tid, toolName: "Thinking", input: { text: get("text") } };
              yield { type: "tool-output-available", toolCallId: tid, output: { completed: true } };
            }
            return;

          case "command_execution":
            if (!startedTools.has(id)) {
              startedTools.add(id);
              yield { type: "tool-input-available", toolCallId: id, toolName: "Bash", input: { command: get("command") } };
            }
            if (completed && get("aggregated_output")) {
              yield { type: "tool-output-available", toolCallId: id, output: get("aggregated_output") };
            }
            return;

          case "file_change": {
            if (!completed) return;
            const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
            for (let i = 0; i < changes.length; i++) {
              const ch = changes[i] ?? {};
              const kind = ch.kind;
              const toolName = kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit";
              const cid = `${id}:${i}`;
              yield { type: "tool-input-available", toolCallId: cid, toolName, input: { file_path: ch.path ?? "" } };
              yield { type: "tool-output-available", toolCallId: cid, output: { completed: true } };
            }
            return;
          }

          case "mcp_tool_call": {
            if (!startedTools.has(id)) {
              startedTools.add(id);
              const toolName = `mcp__${get("server")}__${get("tool")}`;
              yield { type: "tool-input-available", toolCallId: id, toolName, input: item.arguments ?? {} };
            }
            if (completed && item.result !== undefined) {
              const out = typeof item.result === "string" ? item.result : JSON.stringify(item.result);
              yield { type: "tool-output-available", toolCallId: id, output: out };
            }
            return;
          }

          case "web_search":
            if (completed) {
              const wid = genId();
              yield { type: "tool-input-available", toolCallId: wid, toolName: "WebSearch", input: { query: get("query") } };
              yield { type: "tool-output-available", toolCallId: wid, output: { completed: true } };
            }
            return;

          case "error":
            // Non-fatal item notice — surface as prose, not a terminal error.
            if (completed && get("message").trim()) yield* emitText(`⚠️ ${get("message")}`);
            return;
        }
        return;
      }
    }
  };
}
