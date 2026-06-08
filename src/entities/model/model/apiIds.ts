// apiIds.ts — map the router's registry ids to real provider API ids, plus the
// Anthropic reasoning-effort tiers. Pure: no network, no streaming.
import type { Model } from "./registry";

// Map the router's chosen model to a real OpenAI model id. Only OpenAI models
// map to themselves; everything else falls back to a cheap, widely-available one.
export function toOpenAIModel(model: Model): string {
  const real: Record<string, string> = {
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    o3: "gpt-4o", // o3 access varies — substitute a reliable high-tier model
  };
  return real[model.id] ?? "gpt-4o-mini";
}

// Models reachable through a connected ChatGPT (Codex) subscription. The Codex
// backend has no model-list endpoint, so this stays curated — and it only lists
// ids the subscription actually accepts: despite the docs listing gpt-5.4 for
// ChatGPT sign-in, it's rejected with a 400 (verified mid-2026); gpt-5.3-codex
// is also rejected and gpt-5.3-codex-spark is Pro-only. "gpt-5.5" is the default.
export const CODEX_MODELS: { id: string; name: string; note?: string }[] = [
  { id: "gpt-5.5", name: "GPT-5.5", note: "default" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
];

export function toCodexModel(_model: Model): string {
  return CODEX_MODELS[0].id;
}

export function toAnthropicModel(model: Model): string {
  const real: Record<string, string> = {
    "claude-opus-4": "claude-opus-4-20250514",
    "claude-sonnet-4": "claude-sonnet-4-20250514",
    "claude-haiku-3-5": "claude-3-5-haiku-20241022",
  };
  return real[model.id] ?? "claude-haiku-4-5-20251001";
}

// output_config.effort tunes reasoning depth / token spend. GA, no beta header, but
// model-gated: Opus 4.5–4.8 and Sonnet 4.6 only (Haiku, Sonnet 4.5, dated 20250514
// ids, and older 400 on it). xhigh/max are Opus-only. null = no effort support.
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type EffortTier = "opus" | "sonnet";

export function anthropicEffortTier(model: string): EffortTier | null {
  if (/haiku/i.test(model)) return null;
  if (/opus-4-[5-8]\b/i.test(model)) return "opus";
  if (/sonnet-4-6\b/i.test(model)) return "sonnet";
  return null;
}

export const EFFORT_LEVELS: Record<EffortTier, EffortLevel[]> = {
  opus: ["low", "medium", "high", "xhigh", "max"],
  sonnet: ["low", "medium", "high"],
};
const EFFORT_DEFAULT: Record<EffortTier, EffortLevel> = { opus: "high", sonnet: "medium" };

// "auto" (or a level the tier can't use) → that tier's Anthropic-recommended default.
export function resolveEffort(tier: EffortTier, v: EffortLevel | "auto"): EffortLevel {
  return v !== "auto" && EFFORT_LEVELS[tier].includes(v) ? v : EFFORT_DEFAULT[tier];
}
