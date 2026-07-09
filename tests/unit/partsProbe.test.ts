import { describe, it, expect } from "vitest";
import { readUIMessageStream } from "ai";
import { createTransformer } from "@/features/run-agent/lib/transform";

// Contract: our transform's tool/thinking chunks build STATIC `tool-<Name>` parts (we register no
// tool schema), NOT `dynamic-tool`. messageParts.tsx renders on this — if a future AI SDK bump
// changes it to `dynamic-tool`, this breaks and flags the render classifier.
describe("SDK builds static tool parts from our chunks", () => {
  it("yields tool-Thinking / tool-Read parts", async () => {
    const transform = createTransformer();
    const msgs = [
      { type: "assistant", message: { content: [
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        { type: "text", text: "done" },
      ] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "body" }] } },
      { type: "result", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    const chunks: any[] = [];
    for (const m of msgs) for (const c of transform(m)) chunks.push(c);

    const stream = new ReadableStream({
      start(ctrl) { for (const c of chunks) ctrl.enqueue(c); ctrl.close(); },
    });
    let msg: any;
    for await (const m of readUIMessageStream({ stream })) msg = m;

    const types: string[] = (msg?.parts ?? []).map((p: any) => p.type);
    expect(types).toContain("tool-Thinking");
    expect(types).toContain("tool-Read");
    expect(types).toContain("text");
    const read = msg.parts.find((p: any) => p.type === "tool-Read");
    expect(read.input).toEqual({ file_path: "a.ts" });
    expect(read.output).toBe("body");
  });
});
