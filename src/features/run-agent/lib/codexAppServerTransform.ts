import type { UIMessageChunk } from "./uiMessageChunk";

// Codex `app-server` JSON-RPC notifications → AI SDK UIMessageChunk. The warm per-chat process
// (session.rs) forwards every stdout line raw; this decodes the v2 thread/turn surface
// (probe-verified codex-cli 0.142.5, scripts/probeCodexAppServer.mjs). Unlike the old
// `exec --json` path this streams real deltas: item/agentMessage/delta → text-delta,
// item/reasoning/*Delta → reasoning-delta. Tool names are emitted canonical (Bash/Write/Edit/…)
// so the shared renderer treats Claude and Codex uniformly. Approval server requests never reach
// here — codeTransport intercepts them into data-permission parts.
export function createCodexAppServerTransformer() {
  let started = false;
  let startTime: number | null = null;
  let threadId: string | undefined;
  const openText = new Set<string>(); // agentMessage item ids with a text-start emitted
  const openReasoning = new Set<string>(); // reasoning item ids with a reasoning-start emitted
  const startedTools = new Set<string>(); // command/mcp items whose call was already emitted
  const genId = () => `cx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Per-turn token usage = thread totals at turn end minus totals at turn start
  // (thread/tokenUsage/updated carries cumulative thread totals).
  type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number };
  const zero: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let totals: Usage = zero;
  let turnBase: Usage = zero;

  function readUsage(u: any): Usage {
    return {
      inputTokens: u?.inputTokens ?? 0,
      cachedInputTokens: u?.cachedInputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      totalTokens: u?.totalTokens ?? 0,
    };
  }

  function* emitText(text: string): Generator<UIMessageChunk> {
    const id = genId();
    yield { type: "text-start", id };
    yield { type: "text-delta", id, delta: text };
    yield { type: "text-end", id };
  }

  function meta(subtype: string, durationMs?: number) {
    return {
      sessionId: threadId,
      resultSubtype: subtype,
      inputTokens: totals.inputTokens - turnBase.inputTokens,
      cacheReadInputTokens: totals.cachedInputTokens - turnBase.cachedInputTokens,
      outputTokens: totals.outputTokens - turnBase.outputTokens,
      totalTokens: totals.totalTokens - turnBase.totalTokens,
      durationMs: durationMs ?? (startTime ? Date.now() - startTime : undefined),
    };
  }

  // item/started + item/completed share the per-type mapping; `completed` gates outputs.
  function* emitItem(item: any, completed: boolean): Generator<UIMessageChunk> {
    const id = String(item?.id ?? genId());
    const get = (k: string): string => (typeof item?.[k] === "string" ? item[k] : "");

    switch (item?.type) {
      case "agentMessage":
        if (completed) {
          if (openText.has(id)) {
            openText.delete(id);
            yield { type: "text-end", id };
          } else if (get("text").trim()) {
            yield* emitText(get("text")); // no deltas arrived (non-streaming provider)
          }
        }
        return;

      case "reasoning": {
        if (!completed) return;
        if (openReasoning.has(id)) {
          openReasoning.delete(id);
          yield { type: "reasoning-end", id };
        } else {
          const text = get("text") || get("summary");
          if (text.trim()) {
            yield { type: "reasoning-start", id };
            yield { type: "reasoning-delta", id, delta: text };
            yield { type: "reasoning-end", id };
          }
        }
        return;
      }

      case "commandExecution": {
        if (!startedTools.has(id)) {
          startedTools.add(id);
          // commandActions carries the model's logical command; item.command is the shell-wrapped
          // spawn string ("powershell.exe -Command …") — prefer the readable one.
          const logical = Array.isArray(item.commandActions)
            ? item.commandActions.map((a: any) => a?.command).filter(Boolean).join(" && ")
            : "";
          yield {
            type: "tool-input-available",
            toolCallId: id,
            toolName: "Bash",
            input: { command: logical || get("command") },
          };
        }
        if (completed) {
          if (item.status === "failed" && !get("aggregatedOutput")) {
            yield { type: "tool-output-error", toolCallId: id, errorText: "command failed" };
          } else {
            yield { type: "tool-output-available", toolCallId: id, output: get("aggregatedOutput") };
          }
        }
        return;
      }

      case "fileChange": {
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

      case "mcpToolCall": {
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

      case "webSearch":
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
  }

  return function* transform(msg: any): Generator<UIMessageChunk> {
    // JSON-RPC responses ({id,result}) are lifecycle traffic consumed in Rust — only
    // notifications carry transcript content.
    const method: string | undefined = typeof msg?.method === "string" ? msg.method : undefined;
    if (!method || msg?.id !== undefined) return;
    const p = msg.params ?? {};
    // The thread id doubles as the resume id (metadata.sessionId → thread/resume next session).
    // Captured from any notification: thread/started can race the first turn's attach.
    if (typeof p.threadId === "string") threadId = p.threadId;
    if (typeof p.thread?.id === "string") threadId = p.thread.id;

    if (!started) {
      started = true;
      startTime = Date.now();
      yield { type: "start" };
      yield { type: "start-step" };
    }

    switch (method) {
      case "turn/started":
        turnBase = totals;
        return;

      case "item/agentMessage/delta": {
        const id = String(p.itemId ?? "msg");
        if (!openText.has(id)) {
          openText.add(id);
          yield { type: "text-start", id };
        }
        if (typeof p.delta === "string") yield { type: "text-delta", id, delta: p.delta };
        return;
      }

      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const id = String(p.itemId ?? "reasoning");
        if (!openReasoning.has(id)) {
          openReasoning.add(id);
          yield { type: "reasoning-start", id };
        }
        if (typeof p.delta === "string") yield { type: "reasoning-delta", id, delta: p.delta };
        return;
      }

      case "item/started":
        yield* emitItem(p.item, false);
        return;

      case "item/completed":
        yield* emitItem(p.item, true);
        return;

      case "thread/tokenUsage/updated":
        totals = readUsage(p.tokenUsage?.total);
        return;

      case "turn/completed": {
        const turn = p.turn ?? {};
        const status: string = typeof turn.status === "string" ? turn.status : "completed";
        if (status === "failed") {
          yield { type: "error", errorText: turn.error?.message ?? "turn failed" };
        }
        const m = meta(status === "completed" ? "success" : status, turn.durationMs ?? undefined);
        yield { type: "message-metadata", messageMetadata: m };
        yield { type: "finish-step" };
        yield { type: "finish", messageMetadata: m };
        return;
      }

      case "error":
        // Stream-level notice; turn/completed still follows and finishes the turn.
        yield { type: "error", errorText: p.message ?? "stream error" };
        return;
    }
  };
}
