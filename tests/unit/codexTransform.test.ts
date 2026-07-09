import { describe, it, expect } from "vitest";
import { createCodexTransformer } from "@/features/run-agent/lib/codexTransform";
import type { UIMessageChunk } from "@/features/run-agent/lib/uiMessageChunk";

function run(msgs: any[]): UIMessageChunk[] {
  const transform = createCodexTransformer();
  const out: UIMessageChunk[] = [];
  for (const m of msgs) for (const c of transform(m)) out.push(c);
  return out;
}
const types = (cs: UIMessageChunk[]) => cs.map((c) => c.type);

describe("codex transform", () => {
  it("opens with start/start-step once", () => {
    const cs = run([{ type: "thread.started", thread_id: "th-1" }, { type: "thread.started", thread_id: "th-1" }]);
    expect(types(cs)).toEqual(["start", "start-step"]); // thread.started emits no chunk itself
  });

  it("emits an agent_message as a text block", () => {
    const cs = run([{ type: "item.completed", item: { type: "agent_message", id: "m1", text: "done" } }]);
    const deltas = cs.filter((c) => c.type === "text-delta") as Extract<UIMessageChunk, { type: "text-delta" }>[];
    expect(deltas.map((d) => d.delta).join("")).toBe("done");
  });

  it("emits a command as a Bash tool call + output", () => {
    const cs = run([
      { type: "item.started", item: { type: "command_execution", id: "c1", command: "ls" } },
      { type: "item.completed", item: { type: "command_execution", id: "c1", command: "ls", aggregated_output: "a\nb" } },
    ]);
    const call = cs.find((c) => c.type === "tool-input-available") as Extract<UIMessageChunk, { type: "tool-input-available" }>;
    expect(call.toolName).toBe("Bash");
    expect(call.input).toEqual({ command: "ls" });
    const out = cs.find((c) => c.type === "tool-output-available") as Extract<UIMessageChunk, { type: "tool-output-available" }>;
    expect(out.toolCallId).toBe("c1");
    expect(out.output).toBe("a\nb");
  });

  it("finishes on turn.completed with the thread id as session id", () => {
    const cs = run([
      { type: "thread.started", thread_id: "th-9" },
      { type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 4 } },
    ]);
    expect(types(cs)).toContain("finish");
    const meta = cs.find((c) => c.type === "message-metadata") as Extract<UIMessageChunk, { type: "message-metadata" }>;
    expect(meta.messageMetadata.sessionId).toBe("th-9");
    expect(meta.messageMetadata.totalTokens).toBe(10);
  });
});
