// apiIds.ts — map registry ids to real provider API ids + Anthropic effort tiers. Pure: no network.
import type { Model } from "./registry";
import type { Backend } from "./backend";

// Chosen model → real OpenAI id; unmapped falls back by capability tier so the
// routed difficulty survives the mapping.
export function toOpenAIModel(model: Model): string {
  const real: Record<string, string> = {
    "gpt-4o": "gpt-4o",
    "gpt-4o-mini": "gpt-4o-mini",
    o3: "gpt-4o", // o3 access varies — substitute a reliable high-tier
  };
  return real[model.id] ?? (model.cap >= 90 ? "gpt-4o" : "gpt-4o-mini");
}

// FALLBACK Codex model set. The authoritative list is fetched live from codex app-server's
// model/list (subscription-filtered) and cached — see entities/session/api/codexModels.ts. This
// hardcoded set is used only when that fetch is cold/offline, and as the routing-metadata backbone
// (LIVE_CODEX carries the cap/cost/spd scores model/list omits). Ids must match what the installed
// codex CLI advertises verbatim — an unknown id makes a turn silently produce no answer.
export const CODEX_MODELS: { id: string; name: string; note?: string }[] = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", note: "default" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
];

export function toCodexModel(model: Model): string {
  if (CODEX_MODELS.some((m) => m.id === model.id)) return model.id;
  return model.cap >= 90 ? "gpt-5.6-sol" : "gpt-5.6-luna";
}

// Capability tier → Claude family, so an off-registry pick (or a demo model under a
// connected backend) maps by routed difficulty, not to a fixed default.
export type ClaudeFamily = "opus" | "sonnet" | "haiku";
export function claudeFamilyForCap(cap: number): ClaudeFamily {
  return cap >= 95 ? "opus" : cap >= 85 ? "sonnet" : "haiku";
}

// Conservative context window for a live backend's real api id (budgets compaction against
// the model that actually answers). Errs small on unknown ids to avoid overflow.
export function ctxForBackend(b: Backend): string {
  if (b.kind === "anthropic") return "200K"; // all current Claude
  if (/\b(o[1-4]|gpt-5)/i.test(b.model)) return "200K"; // o-series / gpt-5 (incl. Codex)
  return "128K"; // gpt-4o family + unknown — safe default
}

export function toAnthropicModel(model: Model): string {
  const real: Record<string, string> = {
    "claude-opus-4": "claude-opus-4-20250514",
    "claude-sonnet-4": "claude-sonnet-4-20250514",
    "claude-haiku-3-5": "claude-3-5-haiku-20241022",
    "claude-opus-4-8": "claude-opus-4-8",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  };
  const byFamily: Record<ClaudeFamily, string> = {
    opus: "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
  };
  return real[model.id] ?? byFamily[claudeFamilyForCap(model.cap)];
}

// output_config.effort tunes reasoning depth. Model-gated: Opus 4.5–4.8 + Sonnet 4.6 only
// (others 400 on it). xhigh/max are Opus-only. null = unsupported.
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
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

// "auto" or an unsupported level → the tier's default.
export function resolveEffort(tier: EffortTier, v: EffortLevel | "auto"): EffortLevel {
  return v !== "auto" && EFFORT_LEVELS[tier].includes(v) ? v : EFFORT_DEFAULT[tier];
}

// Codex reasoning effort (app-server model/list, probe-verified codex-cli 0.142.5): every current
// codex model advertises the same four levels with a "medium" default. Rides each turn/start —
// a change never respawns the warm process (unlike claude's argv-only --effort).
export const CODEX_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh"];
export const CODEX_EFFORT_DEFAULT: EffortLevel = "medium";

// Auto effort from the routed difficulty score (0–100); resolveEffort still clamps per tier.
export function effortForDifficulty(score: number): EffortLevel {
  return score >= 70 ? "high" : score >= 30 ? "medium" : "low";
}
