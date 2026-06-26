// pricing.ts — real per-token billing math for metered (API-key) turns.
import { dynamicRate } from "@/entities/model/lib/pricingSource";

// Rates (USD per 1M tokens), keyed by *resolved API id* (not registry id); subscriptions are flat-fee.
// NOTE: verify against current provider pricing before relying on the numbers.
const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "claude-opus-4-20250514": { in: 15, out: 75 },
  "claude-sonnet-4-20250514": { in: 3, out: 15 },
  "claude-3-5-haiku-20241022": { in: 0.8, out: 4 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  // Google Gemini (paid tier, prompts ≤200K tokens).
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  "gemini-2.0-flash-lite": { in: 0.075, out: 0.3 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
  // Groq.
  "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
  "llama-3.1-8b-instant": { in: 0.05, out: 0.08 },
  "meta-llama/llama-4-scout-17b-16e-instruct": { in: 0.11, out: 0.34 },
  "meta-llama/llama-4-maverick-17b-128e-instruct": { in: 0.2, out: 0.6 },
  "gemma2-9b-it": { in: 0.2, out: 0.2 },
  "mixtral-8x7b-32768": { in: 0.24, out: 0.24 },
};

// Exact static id, else coarse family fallback (most-specific substring first).
function staticPriceFor(modelId: string): { in: number; out: number } | undefined {
  if (PRICING[modelId]) return PRICING[modelId];
  const fams: [string, { in: number; out: number }][] = [
    ["gpt-4o-mini", PRICING["gpt-4o-mini"]],
    ["gpt-4o", PRICING["gpt-4o"]],
    ["opus", PRICING["claude-opus-4-20250514"]],
    ["sonnet", PRICING["claude-sonnet-4-20250514"]],
    ["haiku", PRICING["claude-haiku-4-5-20251001"]],
    ["gemini-2.5-flash-lite", PRICING["gemini-2.5-flash-lite"]],
    ["gemini-2.5-flash", PRICING["gemini-2.5-flash"]],
    ["gemini-2.5-pro", PRICING["gemini-2.5-pro"]],
    ["gemini-1.5-flash", PRICING["gemini-1.5-flash"]],
    ["gemini-1.5-pro", PRICING["gemini-1.5-pro"]],
    ["flash-lite", PRICING["gemini-2.5-flash-lite"]],
    ["flash", PRICING["gemini-2.5-flash"]],
    ["gemini", PRICING["gemini-2.5-pro"]],
    ["llama-4-maverick", PRICING["meta-llama/llama-4-maverick-17b-128e-instruct"]],
    ["llama-4-scout", PRICING["meta-llama/llama-4-scout-17b-16e-instruct"]],
    ["70b", PRICING["llama-3.3-70b-versatile"]],
    ["8b", PRICING["llama-3.1-8b-instant"]],
    ["gemma", PRICING["gemma2-9b-it"]],
    ["mixtral", PRICING["mixtral-8x7b-32768"]],
  ];
  return fams.find(([sub]) => modelId.includes(sub))?.[1];
}

// Live OpenRouter rate (fresh) wins over the static table.
function priceFor(modelId: string): { in: number; out: number } | undefined {
  return dynamicRate(modelId) ?? staticPriceFor(modelId);
}

// Where a model's price comes from: "live" = OpenRouter catalog, "table" = static fallback, null = unknown.
export function priceSource(modelId: string): "live" | "table" | null {
  if (dynamicRate(modelId)) return "live";
  return staticPriceFor(modelId) ? "table" : null;
}

// Blended USD per 1K tokens from real rates — used as the routing cost score. undefined if unknown.
export function blendedCostPer1K(modelId: string): number | undefined {
  const p = priceFor(modelId);
  return p ? (p.in + p.out) / 2 / 1000 : undefined;
}

// Real USD for a metered turn. Cache-aware: reads bill ~0.1x, writes ~1.25x the input rate.
// undefined when the model's rate is unknown — so the UI can omit the price instead of showing $0.
export function costOf(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
): number | undefined {
  const p = priceFor(modelId);
  if (!p) return undefined;
  const inUnits = usage.inputTokens + (usage.cacheWrite ?? 0) * 1.25 + (usage.cacheRead ?? 0) * 0.1;
  return (inUnits * p.in + usage.outputTokens * p.out) / 1e6;
}
