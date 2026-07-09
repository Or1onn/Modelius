import { describe, it, expect } from "vitest";
import { priceSource, blendedCostPer1K, costOf } from "@/entities/model/lib/pricing";

// dynamicRate reads localStorage (empty in jsdom) → always the static table here.

describe("priceSource", () => {
  it("reports table for known ids/families and null for unknown", () => {
    expect(priceSource("gpt-4o")).toBe("table");
    expect(priceSource("claude-3-opus-20240229")).toBe("table"); // family fallback via "opus"
    expect(priceSource("totally-unknown-model")).toBe(null);
  });
});

describe("blendedCostPer1K", () => {
  it("averages in/out rates per 1K tokens", () => {
    // gpt-4o = { in: 2.5, out: 10 } → (2.5 + 10) / 2 / 1000
    expect(blendedCostPer1K("gpt-4o")).toBeCloseTo(0.00625, 6);
    expect(blendedCostPer1K("unknown")).toBeUndefined();
  });
});

describe("costOf", () => {
  it("bills input + output at the resolved rate", () => {
    expect(costOf("gpt-4o", { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.0125, 6);
  });
  it("discounts cache reads (~0.1x input)", () => {
    expect(costOf("gpt-4o", { inputTokens: 0, outputTokens: 0, cacheRead: 1000 })).toBeCloseTo(0.00025, 6);
  });
  it("is undefined for an unknown model", () => {
    expect(costOf("unknown", { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
  });
});
