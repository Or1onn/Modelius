import { describe, it, expect, vi } from "vitest";
import {
  getPromptSuggestion,
  setPromptSuggestion,
  subscribePromptSuggestion,
} from "@/features/run-agent/lib/promptSuggestion";

describe("promptSuggestion", () => {
  it("stores, trims, and clears per chat", () => {
    setPromptSuggestion("a", "  run the tests  ");
    expect(getPromptSuggestion("a")).toBe("run the tests");
    expect(getPromptSuggestion("b")).toBe(""); // other chats untouched

    setPromptSuggestion("a", "");
    expect(getPromptSuggestion("a")).toBe("");
  });

  it("notifies only its own chat's subscribers, and only on a real change", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = subscribePromptSuggestion("chat-a", onA);
    const offB = subscribePromptSuggestion("chat-b", onB);

    setPromptSuggestion("chat-a", "fix the parser");
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();

    // Same text again — a re-render here would flicker the composer for nothing.
    setPromptSuggestion("chat-a", "fix the parser");
    expect(onA).toHaveBeenCalledTimes(1);

    setPromptSuggestion("chat-a", "");
    expect(onA).toHaveBeenCalledTimes(2);

    offA();
    offB();
    setPromptSuggestion("chat-a", "after unsubscribe");
    expect(onA).toHaveBeenCalledTimes(2);
    setPromptSuggestion("chat-a", "");
  });
});
