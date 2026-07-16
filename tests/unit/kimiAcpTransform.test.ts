import { describe, it, expect } from "vitest";
import { createKimiAcpTransformer, kimiToolName, kimiToolInput } from "@/features/run-agent/lib/kimiAcpTransform";

// Wire-contract lock for the kimi acp stream decode, against lines captured live from
// @moonshot-ai/kimi-code 0.25.0 (scripts/probeKimiAcp.mjs). The Rust pump forwards
// session/update notifications and the turn-terminating session/prompt response.

const SID = "session_a7ae7a72-1800-4f3b-8e87-23cb10ff8eeb";
const update = (u: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: SID, update: u },
});
const chunkMsg = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

function run(transform: (msg: unknown) => Generator<unknown>, msgs: unknown[]): any[] {
  const out: any[] = [];
  for (const m of msgs) for (const c of transform(m)) out.push(c);
  return out;
}

describe("kimi acp transform", () => {
  it("streams message chunks as one text block and finishes on the prompt response", () => {
    const t = createKimiAcpTransformer();
    const chunks = run(t, [
      chunkMsg("He"),
      chunkMsg("llo"),
      { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
    ]);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "message-metadata",
      "finish-step",
      "finish",
    ]);
    // both deltas share the single open block
    expect(chunks[3].id).toBe(chunks[2].id);
    expect(chunks[3].delta).toBe("He");
    // the ACP session id is the resume id
    const meta = chunks.find((c) => c.type === "finish")?.messageMetadata;
    expect(meta.sessionId).toBe(SID);
    expect(meta.resultSubtype).toBe("success");
  });

  it("decodes a captured tool_call + updates into a canonical Bash card", () => {
    const t = createKimiAcpTransformer();
    const chunks = run(t, [
      // captured probe P5 sequence (pending → in_progress → completed)
      update({
        sessionUpdate: "tool_call",
        toolCallId: "0:call_1",
        title: "Bash",
        kind: "execute",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: '{"command":"node -e \\"console.log(\'probe-ran\')\\""}' } }],
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "0:call_1",
        title: 'Running: node -e "console.log(\'probe-ran\')"',
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "node -e \"console.log('probe-ran')\"" },
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "0:call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "probe-ran\n" } }],
        rawOutput: "probe-ran\n",
      }),
    ]);
    const input = chunks.find((c) => c.type === "tool-input-available");
    expect(input.toolName).toBe("Bash");
    expect(input.toolCallId).toBe("0:call_1");
    expect(input.input).toEqual({ command: "node -e \"console.log('probe-ran')\"" });
    const output = chunks.find((c) => c.type === "tool-output-available");
    expect(output.output).toBe("probe-ran\n");
    // in_progress produced no duplicate input card
    expect(chunks.filter((c) => c.type === "tool-input-available")).toHaveLength(1);
  });

  it("interleaves text and tools by closing the open block, and maps failures", () => {
    const t = createKimiAcpTransformer();
    const chunks = run(t, [
      chunkMsg("checking"),
      update({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read", kind: "read", status: "pending" }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "failed", rawOutput: "ENOENT" }),
      chunkMsg("hmm"),
      { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } },
    ]);
    const types = chunks.map((c) => c.type);
    // text block closed before the tool card, new block opened after
    expect(types.indexOf("text-end")).toBeLessThan(types.indexOf("tool-input-available"));
    expect(types.lastIndexOf("text-start")).toBeGreaterThan(types.indexOf("tool-output-error"));
    expect(chunks.find((c) => c.type === "tool-output-error").errorText).toBe("ENOENT");
  });

  it("emits thought chunks as reasoning and plan updates as a TodoWrite card", () => {
    const t = createKimiAcpTransformer();
    const chunks = run(t, [
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering…" } }),
      update({
        sessionUpdate: "plan",
        entries: [
          { content: "read files", status: "completed", priority: "medium" },
          { content: "fix bug", status: "in_progress", priority: "high" },
        ],
      }),
      { jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } },
    ]);
    expect(chunks.some((c) => c.type === "reasoning-delta" && c.delta === "considering…")).toBe(true);
    const todo = chunks.find((c) => c.type === "tool-input-available");
    expect(todo.toolName).toBe("TodoWrite");
    expect(todo.input.todos).toEqual([
      { content: "read files", status: "completed", activeForm: "read files" },
      { content: "fix bug", status: "in_progress", activeForm: "fix bug" },
    ]);
  });

  it("stamps cancelled turns and ignores config/command chatter", () => {
    const t = createKimiAcpTransformer();
    const chunks = run(t, [
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }),
      update({ sessionUpdate: "config_option_update", configOptions: [] }),
      chunkMsg("…"),
      { jsonrpc: "2.0", id: 3, result: { stopReason: "cancelled" } },
    ]);
    expect(chunks.some((c) => c.type === "tool-input-available")).toBe(false);
    expect(chunks.find((c) => c.type === "finish")?.messageMetadata.resultSubtype).toBe("cancelled");
  });

  it("finishes a turn that produced no content at all", () => {
    const t = createKimiAcpTransformer();
    const chunks = run(t, [{ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }]);
    expect(chunks.map((c) => c.type)).toEqual(["start", "start-step", "message-metadata", "finish-step", "finish"]);
  });
});

describe("kimi tool mapping helpers", () => {
  it("keeps bare-identifier titles (kimi's tools are already canonical) and falls back by kind", () => {
    expect(kimiToolName({ title: "Bash", kind: "execute" })).toBe("Bash");
    expect(kimiToolName({ title: "TodoList", kind: "other" })).toBe("TodoList");
    expect(kimiToolName({ title: "Running: npm test", kind: "execute" })).toBe("Bash");
    expect(kimiToolName({ title: "Reading three files", kind: "read" })).toBe("Read");
    expect(kimiToolName({ kind: "fetch" })).toBe("WebFetch");
    expect(kimiToolName({})).toBe("Tool");
  });

  it("prefers rawInput, then parses the args-JSON content, then degrades to a description", () => {
    expect(kimiToolInput({ rawInput: { command: "ls" } })).toEqual({ command: "ls" });
    expect(
      kimiToolInput({ content: [{ type: "content", content: { type: "text", text: '{"file_path":"a.txt"}' } }] })
    ).toEqual({ file_path: "a.txt" });
    expect(kimiToolInput({ content: [{ type: "content", content: { type: "text", text: "not json" } }] })).toEqual({
      description: "not json",
    });
    expect(kimiToolInput({ title: "Bash" })).toEqual({ description: "Bash" });
    expect(kimiToolInput({})).toEqual({});
  });
});
