import { describe, it, expect } from "vitest";
import {
  toOpenAIModel,
  toCodexModel,
  toAnthropicModel,
  claudeFamilyForCap,
  ctxForBackend,
  anthropicEffortTier,
  resolveEffort,
  effortForDifficulty,
} from "@/entities/model/model/apiIds";
import type { Model } from "@/entities/model/model/registry";

// Minimal Model stub — only id + cap drive these mappings.
const m = (id: string, cap: number): Model =>
  ({ id, cap, name: id, abbr: "x", provider: "openai", cost: 0, spd: 0, latency: 0, ctx: "128K" });

describe("toOpenAIModel", () => {
  it("maps known ids and substitutes o3", () => {
    expect(toOpenAIModel(m("gpt-4o", 94))).toBe("gpt-4o");
    expect(toOpenAIModel(m("o3", 97))).toBe("gpt-4o");
  });
  it("falls back by capability tier", () => {
    expect(toOpenAIModel(m("unknown", 95))).toBe("gpt-4o");
    expect(toOpenAIModel(m("unknown", 80))).toBe("gpt-4o-mini");
  });
});

describe("toCodexModel", () => {
  it("keeps subscription ids, else falls back by cap", () => {
    expect(toCodexModel(m("gpt-5.5", 97))).toBe("gpt-5.5");
    expect(toCodexModel(m("unknown", 95))).toBe("gpt-5.6-sol");
    expect(toCodexModel(m("unknown", 80))).toBe("gpt-5.6-luna");
  });
});

describe("claudeFamilyForCap", () => {
  it("splits at 95 (opus) and 85 (sonnet)", () => {
    expect(claudeFamilyForCap(95)).toBe("opus");
    expect(claudeFamilyForCap(94)).toBe("sonnet");
    expect(claudeFamilyForCap(85)).toBe("sonnet");
    expect(claudeFamilyForCap(84)).toBe("haiku");
  });
});

describe("ctxForBackend", () => {
  it("200K for Claude and o-series/gpt-5, 128K otherwise", () => {
    expect(ctxForBackend({ kind: "anthropic", model: "anything" })).toBe("200K");
    expect(ctxForBackend({ kind: "chatgpt", model: "gpt-5.5" })).toBe("200K");
    expect(ctxForBackend({ kind: "openai", model: "o3" })).toBe("200K");
    expect(ctxForBackend({ kind: "compat", model: "llama-3.3-70b" })).toBe("128K");
  });
});

describe("toAnthropicModel", () => {
  it("maps known registry ids to dated api ids", () => {
    expect(toAnthropicModel(m("claude-opus-4", 98))).toBe("claude-opus-4-20250514");
  });
  it("falls back by family for off-registry ids", () => {
    expect(toAnthropicModel(m("mystery", 99))).toBe("claude-opus-4-8");
    expect(toAnthropicModel(m("mystery", 86))).toBe("claude-sonnet-4-6");
    expect(toAnthropicModel(m("mystery", 70))).toBe("claude-haiku-4-5-20251001");
  });
});

describe("anthropicEffortTier", () => {
  it("gates effort by model family", () => {
    expect(anthropicEffortTier("claude-opus-4-8")).toBe("opus");
    expect(anthropicEffortTier("claude-sonnet-4-6")).toBe("sonnet");
    expect(anthropicEffortTier("claude-haiku-4-5-20251001")).toBe(null);
    expect(anthropicEffortTier("gpt-4o")).toBe(null);
  });
  it("gives the gen-5 models the full level set", () => {
    expect(anthropicEffortTier("claude-sonnet-5")).toBe("opus");
    expect(anthropicEffortTier("claude-fable-5")).toBe("opus");
    expect(anthropicEffortTier("claude-mythos-5")).toBe("opus");
  });
});

describe("resolveEffort", () => {
  it("passes supported levels, clamps the rest to the tier default", () => {
    expect(resolveEffort("opus", "max")).toBe("max");
    expect(resolveEffort("sonnet", "max")).toBe("medium"); // max is opus-only
    expect(resolveEffort("opus", "auto")).toBe("high");
    expect(resolveEffort("sonnet", "auto")).toBe("medium");
  });
});

describe("effortForDifficulty", () => {
  it("maps the 0–100 score to a level", () => {
    expect(effortForDifficulty(80)).toBe("high");
    expect(effortForDifficulty(50)).toBe("medium");
    expect(effortForDifficulty(10)).toBe("low");
  });
});
