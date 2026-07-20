import { describe, it, expect } from "vitest";
import { effortsFromCapabilities } from "@/entities/session/api/providerModels";

// Payload shapes copied from a live GET /v1/models (OAuth subscription, 2026-07-20): every model
// object carries `capabilities.effort` with a per-level `supported` flag.
const effort = (levels: Record<string, boolean>, supported = true) => ({
  effort: {
    supported,
    ...Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, { supported: v }])),
  },
});

const ALL = { low: true, medium: true, high: true, xhigh: true, max: true };

describe("effortsFromCapabilities", () => {
  it("reads the full level set (Sonnet 5 / Fable 5 / Opus 4.8)", () => {
    expect(effortsFromCapabilities(effort(ALL))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("drops levels the model doesn't support (Sonnet 4.6 has no xhigh)", () => {
    expect(effortsFromCapabilities(effort({ ...ALL, xhigh: false }))).toEqual(["low", "medium", "high", "max"]);
    // Opus 4.5: neither xhigh nor max.
    expect(effortsFromCapabilities(effort({ ...ALL, xhigh: false, max: false }))).toEqual(["low", "medium", "high"]);
  });

  it("returns an empty set when effort is unsupported (Haiku 4.5)", () => {
    expect(effortsFromCapabilities(effort({ ...ALL, low: false, medium: false, high: false, xhigh: false, max: false }, false))).toEqual([]);
  });

  it("returns an empty set for payloads without capabilities", () => {
    expect(effortsFromCapabilities(undefined)).toEqual([]);
    expect(effortsFromCapabilities({})).toEqual([]);
    expect(effortsFromCapabilities({ effort: {} })).toEqual([]);
  });

  it("orders levels by menu order, not by key order", () => {
    const scrambled = { effort: { supported: true, max: { supported: true }, low: { supported: true } } };
    expect(effortsFromCapabilities(scrambled)).toEqual(["low", "max"]);
  });
});
