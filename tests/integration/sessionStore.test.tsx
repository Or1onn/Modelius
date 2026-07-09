import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// Cut the network/provider/memory/title surface so the store's routing→streaming→idle
// orchestration runs deterministically. A manual modelSel means dispatch uses the given
// backend directly (no pickBackend / classifyRequest), keeping the mock surface small.
vi.mock("@/features/stream-completion/model/streamLLM", () => ({
  streamLLM: async function* () {
    yield { kind: "text", text: "Hello " };
    yield { kind: "text", text: "world" };
    yield { kind: "usage", inputTokens: 10, outputTokens: 2, metered: false };
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

import { useSession, sendMessage } from "@/pages/chat/model/sessionStore";
import type { ModelOption } from "@/entities/model/model/backend";

beforeEach(() => localStorage.clear());

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
});
