import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Cut the network/provider/memory/title surface so the store's routing→streaming→idle
// orchestration runs deterministically. A manual modelSel means dispatch uses the given
// backend directly (no pickBackend / classifyRequest), keeping the mock surface small.
// Scripted stream queue: tests may push generators consumed in order; empty queue falls back
// to the default two-delta happy path.
const stream = vi.hoisted(() => ({
  queue: [] as Array<() => AsyncGenerator<unknown>>,
}));
vi.mock("@/features/stream-completion/model/streamLLM", () => ({
  streamLLM: () => {
    const next = stream.queue.shift();
    if (next) return next();
    return (async function* () {
      yield { kind: "text", text: "Hello " };
      yield { kind: "text", text: "world" };
      yield { kind: "usage", inputTokens: 10, outputTokens: 2, metered: false };
    })();
  },
}));
vi.mock("@/features/pick-backend/model/pickBackend", () => ({
  pickBackend: () => ({ kind: "anthropic", model: "m" }),
  pickSummarizerBackend: () => ({ kind: "none" }),
  liveRoutingPool: () => [],
  modelAllowsWeb: () => false,
}));
vi.mock("@/entities/memory/model/memory", () => ({
  hydrateMemory: async () => {},
  memoryBlock: () => "",
  getMemories: () => [],
  applyMemoryOps: () => [],
}));
vi.mock("@/pages/chat/model/extractMemories", () => ({ extractMemories: async () => [] }));
vi.mock("@/pages/chat/model/generateTitle", () => ({ generateTitle: async () => "" }));

import { useSession, sendMessage, continueMessage } from "@/pages/chat/model/sessionStore";
import type { ModelOption } from "@/entities/model/model/backend";

beforeEach(() => {
  localStorage.clear();
  stream.queue.length = 0;
});

const manual: ModelOption = {
  key: "k",
  label: "Claude",
  provider: "anthropic",
  backend: { kind: "anthropic", model: "m", label: "Claude" },
};

describe("sessionStore.sendMessage", () => {
  it("routes then streams a manual-backend turn to completion", async () => {
    const chatId = "chat-" + Math.random().toString(36).slice(2);
    const { result } = renderHook(() => useSession(chatId, false));

    act(() => {
      sendMessage(chatId, {
        policy: "quality",
        modelSel: manual,
        thinking: false,
        effort: "auto",
        web: false,
        fullText: "hi",
        images: [],
      });
    });

    await waitFor(() => expect(result.current.phase).toBe("idle"), { timeout: 3000 });

    const msgs = result.current.messages;
    expect(msgs[0]).toMatchObject({ role: "user", text: "hi" });
    const asst = msgs[msgs.length - 1];
    expect(asst.role).toBe("assistant");
    expect(asst.text).toBe("Hello world"); // both text deltas accumulated
    expect(asst.streaming).toBeFalsy(); // finalized
    expect(asst.modelLabel).toBe("Claude"); // manual pick badge
  });

  it("continues a max-tokens-truncated turn into the same bubble, folding usage", async () => {
    const chatId = "chat-" + Math.random().toString(36).slice(2);
    const { result } = renderHook(() => useSession(chatId, false));

    // Turn 1: cut off by the output budget → truncated, offers Continue.
    stream.queue.push(async function* () {
      yield { kind: "text", text: "part1" };
      yield { kind: "stop", reason: "max_tokens" };
      yield { kind: "usage", inputTokens: 10, outputTokens: 2, metered: false };
    });
    act(() => {
      sendMessage(chatId, {
        policy: "quality",
        modelSel: manual,
        thinking: false,
        effort: "auto",
        web: false,
        fullText: "hi",
        images: [],
      });
    });
    await waitFor(() => expect(result.current.phase).toBe("idle"), { timeout: 3000 });
    expect(result.current.messages.at(-1)).toMatchObject({ text: "part1", truncated: true });
    const countAfterFirst = result.current.messages.length;

    // Continue: appends into the SAME message; output tokens fold onto the first turn's usage.
    stream.queue.push(async function* () {
      yield { kind: "text", text: " part2" };
      yield { kind: "stop", reason: "end_turn" };
      yield { kind: "usage", inputTokens: 5, outputTokens: 3, metered: false };
    });
    act(() => {
      continueMessage(chatId, { policy: "quality", modelSel: manual, thinking: false, effort: "auto", web: false });
    });
    await waitFor(() => expect(result.current.phase).toBe("idle"), { timeout: 3000 });

    const msgs = result.current.messages;
    expect(msgs.length).toBe(countAfterFirst); // no new bubble
    const asst = msgs[msgs.length - 1];
    expect(asst.text).toBe("part1 part2");
    expect(asst.streaming).toBeFalsy();
    expect(asst.truncated).toBeFalsy(); // end_turn cleared the flag
    expect(asst.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 }); // input kept, output summed
  });
});
