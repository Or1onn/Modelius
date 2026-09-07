import { describe, it, expect } from "vitest";
import { smoothTextStream } from "@/features/run-agent/lib/smoothTextStream";
import type { UIMessageChunk } from "@/features/run-agent/lib/uiMessageChunk";

// Push chunks through the smoother (delay 0 — ordering/slicing only, no timing) and collect output.
async function run(chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const source = new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  const out: UIMessageChunk[] = [];
  const reader = source.pipeThrough(smoothTextStream(0) as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value as UIMessageChunk);
  }
}
const deltas = (cs: UIMessageChunk[]) =>
  (cs.filter((c) => c.type === "text-delta") as Extract<UIMessageChunk, { type: "text-delta" }>[]).map((d) => d.delta);

describe("smoothTextStream", () => {
  it("re-slices sentence-sized deltas into words without losing text", async () => {
    const cs = await run([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Compilers translate source " },
      { type: "text-delta", id: "t1", delta: "code into machine code." },
      { type: "text-end", id: "t1" },
    ]);
    expect(deltas(cs)).toEqual(["Compilers ", "translate ", "source ", "code ", "into ", "machine ", "code."]);
    expect(cs[0]).toEqual({ type: "text-start", id: "t1" });
    expect(cs[cs.length - 1]).toEqual({ type: "text-end", id: "t1" });
  });

  it("holds a partial word until its continuation arrives", async () => {
    const cs = await run([
      { type: "text-delta", id: "t1", delta: "hel" },
      { type: "text-delta", id: "t1", delta: "lo world" },
      { type: "text-end", id: "t1" },
    ]);
    expect(deltas(cs)).toEqual(["hello ", "world"]);
  });

  it("flushes the buffered tail before any non-text chunk (order preserved)", async () => {
    const cs = await run([
      { type: "text-delta", id: "t1", delta: "done" },
      { type: "tool-input-start", toolCallId: "x", toolName: "Read" },
    ]);
    expect(cs.map((c) => c.type)).toEqual(["text-delta", "tool-input-start"]);
    expect(deltas(cs)).toEqual(["done"]);
  });

  it("passes non-text chunks through untouched and flushes on stream end", async () => {
    const meta = { type: "message-metadata", messageMetadata: { sessionId: "s1" } } as unknown as UIMessageChunk;
    const cs = await run([meta, { type: "text-delta", id: "t1", delta: "tail" }]);
    expect(cs[0]).toEqual(meta);
    expect(deltas(cs)).toEqual(["tail"]); // flushed by the stream's flush(), no text-end needed
  });

  it("preserves whitespace exactly across word slices", async () => {
    const text = "a  b\nc\td ";
    const cs = await run([
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
    ]);
    expect(deltas(cs).join("")).toBe(text);
  });
});
