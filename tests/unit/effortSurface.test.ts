import { describe, it, expect, beforeEach } from "vitest";
import { effortSurface, pickEffort } from "@/entities/session/api/effortSurface";
import { codeEffortInfo } from "@/features/run-agent/lib/codeChatRegistry";

const OPENROUTER_CAPS = JSON.stringify({
  at: Date.now(),
  rates: {},
  vis: {},
  imgOut: {},
  caps: { claudesonnet5: true, llama38b: false },
});

// effortSurface dispatches per provider and answers from that provider's live catalog. These cover
// the dispatch plus the cold-cache fallbacks (no account connected), which is what a fresh install
// hits; the live capability mapping itself is covered by effortCapabilities.test.ts.
describe("effortSurface", () => {
  beforeEach(() => localStorage.clear());

  it("gives Anthropic picks the levels their generation supports", () => {
    expect(effortSurface("anthropic", "claude-sonnet-5")?.levels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortSurface("anthropic", "claude-opus-4-8")?.dflt).toBe("high");
    expect(effortSurface("anthropic", "claude-haiku-4-5-20251001")).toBe(null);
  });

  it("falls back to the static codex set when no ChatGPT account is connected", () => {
    const s = effortSurface("codex", "gpt-5.6-sol");
    expect(s?.levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(s?.dflt).toBe("medium");
  });

  it("offers effort for OpenRouter models the catalog marks as reasoning", () => {
    localStorage.setItem("modelius.pricing.openrouter", OPENROUTER_CAPS);
    expect(effortSurface("openrouter", "anthropic/claude-sonnet-5")?.levels).toEqual(["low", "medium", "high"]);
    expect(effortSurface("openrouter", "meta/llama-3-8b")).toBe(null);
    expect(effortSurface("openrouter", "some/unlisted-model")).toBe(null); // not in the catalog
  });

  it("gives no knob to sources with no catalog to ask", () => {
    // kimi is unprobed (its CLI demands a login before session/new), not known-unsupported.
    expect(effortSurface("kimi", "kimi-k2.7-code")).toBe(null);
    expect(effortSurface("ollama", "llama3")).toBe(null);
    expect(effortSurface("connected", "gpt-4o")).toBe(null);
    expect(effortSurface("gateway", "whatever")).toBe(null);
  });
});

// A Code-mode pick routed through the local proxy is really the provider behind it — the knob has
// to follow the provider, not the "connected"/"gateway" wrapper, or Code and Chat disagree about
// the same model.
describe("codeEffortInfo for routed picks", () => {
  beforeEach(() => localStorage.clear());

  it("asks the provider behind a connected pick, not the wrapper", () => {
    localStorage.setItem("modelius.pricing.openrouter", OPENROUTER_CAPS);
    const info = codeEffortInfo({
      kind: "connected",
      id: "anthropic/claude-sonnet-5",
      label: "Claude Sonnet 5",
      providerId: "openrouter",
    });
    expect(info.levels).toEqual(["low", "medium", "high"]);
  });

  it("treats an OpenRouter-hosted gateway as OpenRouter", () => {
    localStorage.setItem("modelius.pricing.openrouter", OPENROUTER_CAPS);
    localStorage.setItem(
      "modelius.code.gateways",
      JSON.stringify([
        { id: "g1", name: "OR", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5", protocol: "openai" },
        { id: "g2", name: "Local", baseUrl: "http://127.0.0.1:4000", model: "whatever", protocol: "openai" },
      ])
    );
    const or = codeEffortInfo({ kind: "gateway", id: "anthropic/claude-sonnet-5", label: "OR", gatewayId: "g1" });
    expect(or.levels).toEqual(["low", "medium", "high"]);
    // A gateway the proxy can't translate reasoning for keeps no knob.
    const other = codeEffortInfo({ kind: "gateway", id: "whatever", label: "Local", gatewayId: "g2" });
    expect(other.levels).toBe(null);
  });

  it("keeps no knob for a connected provider without a reasoning catalog", () => {
    const info = codeEffortInfo({ kind: "connected", id: "gpt-4o", label: "GPT-4o", providerId: "openai" });
    expect(info.levels).toBe(null);
  });
});

describe("pickEffort", () => {
  const surface = { levels: ["low", "medium", "high"] as const, dflt: "medium" as const };

  it("keeps a supported pick and clamps everything else to the default", () => {
    expect(pickEffort({ ...surface, levels: [...surface.levels] }, "low")).toBe("low");
    expect(pickEffort({ ...surface, levels: [...surface.levels] }, "auto")).toBe("medium");
    expect(pickEffort({ ...surface, levels: [...surface.levels] }, "max")).toBe("medium"); // unsupported here
  });
});
