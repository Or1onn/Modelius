import { describe, it, expect } from "vitest";
import { applyDelta, type Step } from "@/features/run-agent/lib/agentChannel";

describe("applyDelta", () => {
  const base: Step[] = [{ type: "user", text: "hi" }];

  it("appends an error as a ⚠️ text step", () => {
    const out = applyDelta(base, { op: "error", message: "boom" });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ type: "text", text: "⚠️ boom" });
  });

  it("leaves steps untouched for session and usage deltas", () => {
    expect(applyDelta(base, { op: "session", id: "s-1" })).toBe(base);
    expect(applyDelta(base, { op: "usage", contextTokens: 5, cost: null })).toBe(base);
  });

  it("groups adjacent tool calls and patches a result in by id", () => {
    let steps = applyDelta(base, { op: "tool", item: { id: "t1", verb: "Read", file: "a.ts" } });
    steps = applyDelta(steps, { op: "tool", item: { id: "t2", verb: "Edit", file: "b.ts" } });
    expect(steps).toHaveLength(2); // one toolgroup, not two
    steps = applyDelta(steps, { op: "result", id: "t1", output: "ok" });
    const group = steps[1] as Extract<Step, { type: "toolgroup" }>;
    expect(group.items[0].output).toBe("ok");
    expect(group.items[1].output).toBeUndefined();
  });
});
