import type { UIMessageChunk } from "./uiMessageChunk";
import { finishTurn, startGate } from "./baseTransformer";

// Kimi `acp` (Agent Client Protocol) JSONL → AI SDK UIMessageChunk. The warm per-chat process
// (session.rs) forwards session/update notifications and the turn-terminating session/prompt
// response raw; this decodes them (probe-verified @moonshot-ai/kimi-code 0.25.0).
// Kimi's tool titles are already Claude-canonical names (Bash / Edit /
// Read / Write / Glob / Grep / TodoList / …), so the shared renderer treats all three harnesses
// uniformly; the ACP `kind` only backstops descriptive titles. Permission server requests never
// reach here — codeTransport intercepts them into data-permission parts.

// ACP tool-call kind → canonical tool name, used only when the title isn't a bare tool
// identifier (e.g. an in-progress title like `Running: npm test`).
function toolFromKind(kind: string): string {
  switch (kind) {
    case "execute":
      return "Bash";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Edit";
    case "read":
      return "Read";
    case "search":
      return "Grep";
    case "fetch":
      return "WebFetch";
    default:
      return "Tool";
  }
}

// Resolve the canonical tool name for a tool_call update. Exported for the transport's
// permission decode (session/request_permission carries the same toolCall shape).
export function kimiToolName(toolCall: { title?: unknown; kind?: unknown }): string {
  const title = typeof toolCall.title === "string" ? toolCall.title : "";
  if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(title)) return title; // bare identifier = the tool itself
  return toolFromKind(typeof toolCall.kind === "string" ? toolCall.kind : "");
}

// Flatten ACP content blocks ([{type:"content",content:{type:"text",text}}, …]) to plain text.
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (typeof b?.content?.text === "string" ? b.content.text : typeof b?.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Best-effort input object for a tool call: rawInput when present (in_progress updates carry
// it), else the pending update's content text — which is the JSON-encoded args string.
export function kimiToolInput(update: { rawInput?: unknown; content?: unknown; title?: unknown }): Record<string, unknown> {
  if (update.rawInput && typeof update.rawInput === "object") return update.rawInput as Record<string, unknown>;
  const text = contentText(update.content);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON — fall through
    }
    return { description: text };
  }
  return typeof update.title === "string" && update.title ? { description: update.title } : {};
}

export function createKimiAcpTransformer() {
  const gate = startGate();
  let sessionId: string | undefined;
  // Resume id surfaced this turn? Must land early — a cancelled turn never sees its
  // finishTurn metadata (the transport's abort closes the stream first).
  let sessionMetaSent = false;
  let openTextId: string | null = null; // ACP chunks carry no item ids — one open block at a time
  let openThoughtId: string | null = null;
  const startedTools = new Map<string, string>(); // toolCallId → resolved toolName
  const erroredTools = new Set<string>(); // failed ids — a later completed must not double-output
  let seq = 0;
  const genId = (prefix: string) => `km-${prefix}-${Date.now()}-${seq++}`;

  function* closeBlocks(): Generator<UIMessageChunk> {
    if (openTextId) {
      yield { type: "text-end", id: openTextId };
      openTextId = null;
    }
    if (openThoughtId) {
      yield { type: "reasoning-end", id: openThoughtId };
      openThoughtId = null;
    }
  }

  function* emitUpdate(u: any): Generator<UIMessageChunk> {
    switch (u?.sessionUpdate) {
      case "agent_message_chunk": {
        const text = typeof u.content?.text === "string" ? u.content.text : "";
        if (!text) return;
        if (openThoughtId) {
          yield { type: "reasoning-end", id: openThoughtId };
          openThoughtId = null;
        }
        if (!openTextId) {
          openTextId = genId("t");
          yield { type: "text-start", id: openTextId };
        }
        yield { type: "text-delta", id: openTextId, delta: text };
        return;
      }

      case "agent_thought_chunk": {
        const text = typeof u.content?.text === "string" ? u.content.text : "";
        if (!text) return;
        if (openTextId) {
          yield { type: "text-end", id: openTextId };
          openTextId = null;
        }
        if (!openThoughtId) {
          openThoughtId = genId("r");
          yield { type: "reasoning-start", id: openThoughtId };
        }
        yield { type: "reasoning-delta", id: openThoughtId, delta: text };
        return;
      }

      case "tool_call": {
        yield* closeBlocks();
        const id = String(u.toolCallId ?? genId("tc"));
        if (!startedTools.has(id)) {
          const toolName = kimiToolName(u);
          startedTools.set(id, toolName);
          yield { type: "tool-input-available", toolCallId: id, toolName, input: kimiToolInput(u) };
        }
        return;
      }

      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        if (!id) return;
        // A tool that skipped the pending phase (auto-approved fast path) still gets its card.
        if (!startedTools.has(id)) {
          const toolName = kimiToolName(u);
          startedTools.set(id, toolName);
          yield* closeBlocks();
          yield { type: "tool-input-available", toolCallId: id, toolName, input: kimiToolInput(u) };
        }
        if (u.status === "failed") {
          erroredTools.add(id);
          yield {
            type: "tool-output-error",
            toolCallId: id,
            errorText: contentText(u.content) || (typeof u.rawOutput === "string" ? u.rawOutput : "tool failed"),
          };
        } else if (u.status === "completed" && !erroredTools.has(id)) {
          const out = typeof u.rawOutput === "string" ? u.rawOutput : contentText(u.content);
          yield { type: "tool-output-available", toolCallId: id, output: out };
        }
        return;
      }

      case "plan": {
        // Render the agent's plan through the TodoWrite card the transcript already knows.
        const entries: any[] = Array.isArray(u.entries) ? u.entries : [];
        if (!entries.length) return;
        const todos = entries.map((e) => ({
          content: typeof e?.content === "string" ? e.content : "",
          status: e?.status === "completed" ? "completed" : e?.status === "in_progress" ? "in_progress" : "pending",
          activeForm: typeof e?.content === "string" ? e.content : "",
        }));
        const id = genId("plan");
        yield { type: "tool-input-available", toolCallId: id, toolName: "TodoWrite", input: { todos } };
        yield { type: "tool-output-available", toolCallId: id, output: { completed: true } };
        return;
      }

      // Config/command chatter — not transcript content.
      case "available_commands_update":
      case "config_option_update":
      case "current_mode_update":
        return;
    }
  }

  return function* transform(msg: any): Generator<UIMessageChunk> {
    // The session/prompt RESPONSE ({id, result:{stopReason}}) is the turn terminator here —
    // unlike codex, id-carrying lines are transcript content, not just lifecycle traffic.
    if (msg?.id !== undefined && msg?.method === undefined) {
      const stopReason: string = typeof msg?.result?.stopReason === "string" ? msg.result.stopReason : "end_turn";
      // A turn can end without any content update (e.g. an instant refusal) — the SDK still
      // needs the start frame before finish; no clock means no bogus 0ms duration.
      yield* gate.ensure({ clock: false });
      yield* closeBlocks();
      if (stopReason === "refusal") {
        yield { type: "error", errorText: "The model refused to continue this turn." };
      }
      yield* finishTurn({
        sessionId,
        resultSubtype: stopReason === "end_turn" ? "success" : stopReason,
        durationMs: gate.elapsed(),
      });
      return;
    }
    if (msg?.method !== "session/update") return;
    const p = msg.params ?? {};
    // The ACP session id doubles as the resume id (metadata.sessionId → session/resume next spawn).
    if (typeof p.sessionId === "string") sessionId = p.sessionId;

    yield* gate.ensure();

    if (!sessionMetaSent && sessionId) {
      sessionMetaSent = true;
      yield { type: "message-metadata", messageMetadata: { sessionId } };
    }

    yield* emitUpdate(p.update);
  };
}
