// tiers.ts — routing weights per capability tier, used to score endpoints that report no
// metric of their own (local Ollama models, key-provider catalogs).
export type ModelTier = "fast" | "balanced" | "top";

export const TIER_WEIGHTS: Record<ModelTier, { cap: number; cost: number; spd: number; latency: number }> = {
  fast: { cap: 78, cost: 0.0005, spd: 95, latency: 0.3 },
  balanced: { cap: 86, cost: 0.002, spd: 80, latency: 0.8 },
  top: { cap: 95, cost: 0.008, spd: 60, latency: 1.5 },
};
