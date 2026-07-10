import { describe, it, expect, vi } from "vitest";
import {
  getTurnStatus,
  subscribeTurnStatus,
  noteTurnStderr,
  bumpTurnActivity,
  clearTurnStatus,
} from "@/features/run-agent/lib/turnStatus";

describe("turn status store", () => {
  it("surfaces a stderr line as the note and clears it on fresh stdout", () => {
    noteTurnStderr("c1", "  retrying request (attempt 2)…  ");
    expect(getTurnStatus("c1").note).toBe("retrying request (attempt 2)…");
    bumpTurnActivity("c1"); // stdout resumed — the retry note is stale
    expect(getTurnStatus("c1").note).toBeNull();
    expect(getTurnStatus("c1").activityAt).toBeGreaterThan(0);
    clearTurnStatus("c1");
    expect(getTurnStatus("c1").activityAt).toBe(0);
  });

  it("throttles activity bumps but never a note change", () => {
    const cb = vi.fn();
    const off = subscribeTurnStatus("c2", cb);
    bumpTurnActivity("c2");
    bumpTurnActivity("c2"); // within the 2s coarse window — dropped
    expect(cb).toHaveBeenCalledTimes(1);
    noteTurnStderr("c2", "backing off 8s"); // notes always notify
    expect(cb).toHaveBeenCalledTimes(2);
    bumpTurnActivity("c2"); // clears the note even inside the window
    expect(getTurnStatus("c2").note).toBeNull();
    expect(cb).toHaveBeenCalledTimes(3);
    off();
    clearTurnStatus("c2");
    expect(cb).toHaveBeenCalledTimes(3); // unsubscribed
  });

  it("ignores blank stderr lines and unknown-chat clears", () => {
    noteTurnStderr("c3", "   ");
    expect(getTurnStatus("c3").note).toBeNull();
    clearTurnStatus("never-seen"); // no throw, no phantom notify
  });
});
