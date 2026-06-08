// pricing.ts — real per-token billing math for metered (API-key) turns.

// Real per-token billing rates (USD per 1M tokens), keyed by the *resolved API id*
// the key path actually sends (toOpenAIModel / toAnthropicModel) — not the registry
// id. Only metered (API-key) paths need entries; subscriptions are flat-fee.
// NOTE: verify against current provider pricing before relying on the numbers.
const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "claude-opus-4-20250514": { in: 15, out: 75 },
  "claude-sonnet-4-20250514": { in: 3, out: 15 },
  "claude-3-5-haiku-20241022": { in: 0.8, out: 4 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

// Exact id, else a coarse family fallback (longest-prefix-ish substrings first).
function priceFor(modelId: string): { in: number; out: number } | undefined {
  if (PRICING[modelId]) return PRICING[modelId];
  const fams: [string, { in: number; out: number }][] = [
    ["gpt-4o-mini", PRICING["gpt-4o-mini"]],
    ["gpt-4o", PRICING["gpt-4o"]],
    ["opus", PRICING["claude-opus-4-20250514"]],
    ["sonnet", PRICING["claude-sonnet-4-20250514"]],
    ["haiku", PRICING["claude-haiku-4-5-20251001"]],
  ];
  return fams.find(([sub]) => modelId.includes(sub))?.[1];
}

// Real USD for a metered turn. Cache-aware: with prompt caching, Anthropic's
// input_tokens is the uncached remainder, cache reads bill at ~0.1x and writes at
// ~1.25x the input rate. Returns 0 when the model id has no known rate.
export function costOf(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  const inUnits = usage.inputTokens + (usage.cacheWrite ?? 0) * 1.25 + (usage.cacheRead ?? 0) * 0.1;
  return (inUnits * p.in + usage.outputTokens * p.out) / 1e6;
}
