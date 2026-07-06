// channel.ts — bridge a Rust streaming command (events over a Tauri Channel) into an async generator of Deltas.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Delta } from "@/entities/model/model/backend";

// Raw usage payload from Rust; cache fields are optional (the compat proxy omits them).
export type RawUsage = { input_tokens: number; output_tokens: number; cache_read?: number; cache_write?: number; reasoning_tokens?: number; cost?: number | null };

export type StreamEvent =
  | { type: "chunk"; data: string }
  | { type: "thinking"; data: string }
  | { type: "image"; data: string }
  | { type: "usage"; data: RawUsage }
  | { type: "stop_reason"; data: string }
  | { type: "done" }
  | { type: "error"; data: string };

// `start` gets the channel and returns the invoke() promise (provider picks the command + args).
// `mapUsage` builds the usage Delta (cache fields and the `metered` flag differ per provider).
// `onError` runs once before the error is thrown (e.g. drop a dead OAuth token on 401).
export async function* channelToDeltas(
  start: (channel: Channel<StreamEvent>) => Promise<unknown>,
  mapUsage: (u: RawUsage) => Delta,
  onError?: (msg: string) => void,
  signal?: AbortSignal,
  streamId?: string
): AsyncGenerator<Delta> {
  const channel = new Channel<StreamEvent>();
  const queue: Delta[] = [];
  let finished = false;
  let error: string | null = null;
  let wake: (() => void) | null = null;
  const ping = () => {
    wake?.();
    wake = null;
  };
  // Abort: stop consuming the channel promptly and tell the Rust proxy to drop the upstream
  // connection (cancel_stream by id). The partial output already streamed stays put.
  if (signal) {
    const onAbort = () => {
      finished = true;
      if (streamId) void invoke("cancel_stream", { streamId }).catch(() => {});
      ping();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  channel.onmessage = (msg) => {
    if (msg.type === "chunk") queue.push({ kind: "text", text: msg.data });
    else if (msg.type === "thinking") queue.push({ kind: "thinking", text: msg.data });
    else if (msg.type === "image") queue.push({ kind: "image", dataUrl: msg.data });
    else if (msg.type === "usage") queue.push(mapUsage(msg.data));
    else if (msg.type === "stop_reason") queue.push({ kind: "stop", reason: msg.data });
    else if (msg.type === "error") {
      error = msg.data;
      finished = true;
    } else finished = true;
    ping();
  };

  const call = start(channel);
  call.catch((e) => {
    error = e instanceof Error ? e.message : String(e);
    finished = true;
    ping();
  });

  while (true) {
    if (queue.length) {
      yield queue.shift() as Delta;
      continue;
    }
    if (error) {
      onError?.(error);
      throw new Error(error);
    }
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await call.catch(() => {});
}
