import { describe, it, expect } from "vitest";
import { createTransformer } from "@/features/run-agent/lib/transform";
import type { UIMessageChunk } from "@/features/run-agent/lib/uiMessageChunk";

// Drive the Claude stream-json → UIMessageChunk transform with a realistic message sequence.
function run(msgs: any[]): UIMessageChunk[] {
  const transform = createTransformer();
  const out: UIMessageChunk[] = [];
  for (const m of msgs) for (const c of transform(m)) out.push(c);
  return out;
}
const types = (cs: UIMessageChunk[]) => cs.map((c) => c.type);

describe("claude transform", () => {
  it("streams text as start/delta/end", () => {
    const cs = run([
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } } },
      { type: "stream_event", event: { type: "content_block_stop" } },
    ]);
    expect(types(cs)).toEqual(["start", "start-step", "text-start", "text-delta", "text-delta", "text-end"]);
    const deltas = cs.filter((c) => c.type === "text-delta") as Extract<UIMessageChunk, { type: "text-delta" }>[];
    expect(deltas.map((d) => d.delta).join("")).toBe("hello");
  });

  it("emits a tool call from an assistant tool_use block", () => {
    const cs = run([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
    ]);
    const tool = cs.find((c) => c.type === "tool-input-available") as Extract<UIMessageChunk, { type: "tool-input-available" }>;
    expect(tool.toolCallId).toBe("t1");
    expect(tool.toolName).toBe("Read");
    expect(tool.input).toEqual({ file_path: "a.ts" });
  });

  it("matches a tool_result to its call by id", () => {
    const cs = run([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } },
    ]);
    const out = cs.find((c) => c.type === "tool-output-available") as Extract<UIMessageChunk, { type: "tool-output-available" }>;
    expect(out.toolCallId).toBe("t1");
    expect(out.output).toBe("file body");
  });

  it("finishes with metadata carrying the session id", () => {
    const cs = run([
      { type: "result", session_id: "sess-9", total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    expect(types(cs)).toContain("message-metadata");
    expect(types(cs)).toContain("finish");
    const meta = cs.find((c) => c.type === "message-metadata") as Extract<UIMessageChunk, { type: "message-metadata" }>;
    expect(meta.messageMetadata.sessionId).toBe("sess-9");
    expect(meta.messageMetadata.totalCostUsd).toBe(0.02);
  });

  // Regression: subagent (sidechain) lines interleave with the MAIN thread's stream_events
  // (captured live from claude 2.1.206 with background Task agents). They must not flush the
  // main thread's half-streamed tool input or end the turn.
  it("keeps a streaming tool input intact across an interleaved sidechain assistant line", () => {
    const cs = run([
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } }, parent_tool_use_id: null },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"file_path": "a' } }, parent_tool_use_id: null },
      // subagent narration + tool call land mid-stream, complete, parent-tagged
      { type: "assistant", message: { content: [{ type: "text", text: "I'll run the sleep command now." }] }, parent_tool_use_id: "toolu_parent" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "sub1", name: "Bash", input: { command: "sleep 8" } }] }, parent_tool_use_id: "toolu_parent" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '.ts"}' } }, parent_tool_use_id: null },
      { type: "stream_event", event: { type: "content_block_stop" }, parent_tool_use_id: null },
    ]);
    const read = cs.find(
      (c) => c.type === "tool-input-available" && (c as { toolName?: string }).toolName === "Read"
    ) as Extract<UIMessageChunk, { type: "tool-input-available" }>;
    expect(read.input).toEqual({ file_path: "a.ts" }); // whole input survived the interleave
    const sub = cs.find(
      (c) => c.type === "tool-input-available" && (c as { toolName?: string }).toolName === "Bash"
    ) as Extract<UIMessageChunk, { type: "tool-input-available" }>;
    expect(sub.toolCallId).toBe("toolu_parent:sub1"); // sidechain tool still renders, nested
  });

  it("ignores a sidechain result and finishes only on the top-level one", () => {
    const cs = run([
      { type: "result", subtype: "success", parent_tool_use_id: "toolu_parent", session_id: "sub" },
      { type: "result", subtype: "success", parent_tool_use_id: null, session_id: "sess-9" },
    ]);
    expect(cs.filter((c) => c.type === "finish")).toHaveLength(1);
    const meta = cs.find((c) => c.type === "message-metadata") as Extract<UIMessageChunk, { type: "message-metadata" }>;
    expect(meta.messageMetadata.sessionId).toBe("sess-9");
  });
});
