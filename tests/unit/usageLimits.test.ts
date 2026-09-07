// mergeWindows — rate-limit windows must not flicker: a window absent from one response
// (the premium-weekly "7d_oi" headers ride some responses and not others) stays visible
// until its reset passes; a window present in the new parse always wins.
import { describe, expect, it } from "vitest";
import { mergeWindows, type LimitWindow } from "@/entities/session/model/usageLimits";

const HOUR = 3_600_000;
const w = (key: string, label: string, usedPct: number, resetsAt?: number): LimitWindow => ({ key, label, usedPct, resetsAt });

describe("mergeWindows", () => {
  it("returns the new parse when nothing was cached", () => {
    const next = [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR)];
    expect(mergeWindows(undefined, next)).toEqual(next);
    expect(mergeWindows([], next)).toEqual(next);
  });

  it("keeps a known window that is merely absent from the new response", () => {
    const weekly = w("u:7d_oi", "Weekly · Opus", 0.4, Date.now() + 3 * 24 * HOUR);
    const prev = [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR), weekly];
    const next = [w("u:5h", "5-hour limit", 0.3, Date.now() + HOUR)];
    const out = mergeWindows(prev, next);
    expect(out.map((x) => x.key)).toEqual(["u:5h", "u:7d_oi"]);
    expect(out[0].usedPct).toBe(0.3); // fresh value wins
    expect(out[1]).toEqual(weekly); // absent window retained as-is
  });

  it("updates a window present in both, preserving previous order", () => {
    const prev = [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR), w("u:7d", "Weekly · all models", 0.5, Date.now() + 24 * HOUR)];
    const next = [w("u:7d", "Weekly · all models", 0.6, Date.now() + 24 * HOUR), w("u:5h", "5-hour limit", 0.1, Date.now() + HOUR)];
    const out = mergeWindows(prev, next);
    expect(out.map((x) => [x.key, x.usedPct])).toEqual([["u:5h", 0.1], ["u:7d", 0.6]]);
  });

  it("drops a retained window once its reset has passed", () => {
    const prev = [w("u:7d_oi", "Weekly · Opus", 0.4, Date.now() - 1000)];
    expect(mergeWindows(prev, [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR)]).map((x) => x.key)).toEqual(["u:5h"]);
  });

  it("drops absent windows without a key or reset (pre-key cache, unjudgeable freshness)", () => {
    const prev: LimitWindow[] = [
      { label: "7d_oi", usedPct: 0.4, resetsAt: Date.now() + 24 * HOUR }, // old cache format: no key
      w("u:7d", "Weekly · all models", 0.5), // keyed but no resetsAt
    ];
    expect(mergeWindows(prev, [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR)]).map((x) => x.key)).toEqual(["u:5h"]);
  });

  it("appends genuinely new windows after known ones", () => {
    const prev = [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR)];
    const next = [w("u:5h", "5-hour limit", 0.3, Date.now() + HOUR), w("u:7d_oi", "Weekly · Opus", 0.1, Date.now() + 24 * HOUR)];
    expect(mergeWindows(prev, next).map((x) => x.key)).toEqual(["u:5h", "u:7d_oi"]);
  });

  it("replaces an unkeyed cached window with the keyed fresh one, no duplicate row", () => {
    const prev: LimitWindow[] = [{ label: "5-hour limit", usedPct: 0.9 }];
    const out = mergeWindows(prev, [w("u:5h", "5-hour limit", 0.2, Date.now() + HOUR)]);
    expect(out).toHaveLength(1);
    expect(out[0].usedPct).toBe(0.2);
  });
});
