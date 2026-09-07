// smoothTextStream.ts — client-side typewriter smoothing for the code transport. The harness CLIs
// coalesce API token deltas into big chunks (probe: claude 2.1.206 ships a whole paragraph as ~4
// text_delta lines ~400ms apart), so without smoothing a short answer visually "pops in" at once.
// This TransformStream re-slices `text-delta` chunks on word boundaries and releases one word per
// `delayMs` (same shape as the AI SDK's server-side smoothStream: word chunking, 10ms default).
// Every other chunk type passes through untouched; the async transform's backpressure preserves
// ordering (a `text-end` or `finish` queued behind an animating block waits for it to drain).
import type { UIMessageChunk } from "ai";

// A word plus its trailing whitespace — the release unit. Text with no trailing whitespace yet
// (a partial word at the buffer tail) stays buffered until the next delta or the flush.
const WORD = /\S*\s+/y;

export function smoothTextStream(delayMs = 10): TransformStream<UIMessageChunk, UIMessageChunk> {
  let buffer = "";
  let bufferId: string | null = null;
  const sleep = () => new Promise<void>((r) => setTimeout(r, delayMs));

  async function drain(controller: TransformStreamDefaultController<UIMessageChunk>, flush: boolean): Promise<void> {
    if (bufferId === null) return;
    let pos = 0;
    for (;;) {
      WORD.lastIndex = pos;
      const m = WORD.exec(buffer);
      if (!m) break;
      controller.enqueue({ type: "text-delta", id: bufferId, delta: m[0] });
      pos = WORD.lastIndex;
      if (delayMs > 0) await sleep();
    }
    buffer = buffer.slice(pos);
    if (flush && buffer) {
      controller.enqueue({ type: "text-delta", id: bufferId, delta: buffer });
      buffer = "";
    }
    if (flush) bufferId = null;
  }

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    async transform(chunk, controller) {
      if (chunk.type === "text-delta") {
        // A new text block while another is buffered (shouldn't happen — transforms close blocks
        // before opening the next) — flush the stale tail so no text is lost.
        if (bufferId !== null && bufferId !== chunk.id) await drain(controller, true);
        bufferId = chunk.id;
        buffer += chunk.delta;
        await drain(controller, false);
        return;
      }
      // The block's end (or anything else) flushes the partial word first, keeping chunk order.
      await drain(controller, true);
      controller.enqueue(chunk);
    },
    async flush(controller) {
      await drain(controller, true);
    },
  });
}
