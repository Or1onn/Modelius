import type { MessageMetadata, UIMessageChunk } from "./uiMessageChunk";

// Plumbing shared by the three harness transformers (claude stream-json / codex app-server /
// kimi acp): the once-only start frame with the turn clock, and the metadata + finish trailer
// every turn ends with.

export interface StartGate {
  readonly started: boolean;
  // Emit the start frame once. `clock: false` marks the turn started without arming the
  // duration clock (kimi: a turn that ends with zero content reports no duration).
  ensure(opts?: { clock?: boolean }): Generator<UIMessageChunk>;
  // ms since the first chunk, or undefined before the clock armed.
  elapsed(): number | undefined;
}

export function startGate(): StartGate {
  let started = false;
  let startTime: number | null = null;
  return {
    get started() {
      return started;
    },
    *ensure(opts?: { clock?: boolean }): Generator<UIMessageChunk> {
      if (started) return;
      started = true;
      if (opts?.clock !== false) startTime = Date.now();
      yield { type: "start" };
      yield { type: "start-step" };
    },
    elapsed() {
      return startTime ? Date.now() - startTime : undefined;
    },
  };
}

// message-metadata + finish-step + finish, all carrying the same turn metadata.
export function* finishTurn(meta: MessageMetadata): Generator<UIMessageChunk> {
  yield { type: "message-metadata", messageMetadata: meta };
  yield { type: "finish-step" };
  yield { type: "finish", messageMetadata: meta };
}
