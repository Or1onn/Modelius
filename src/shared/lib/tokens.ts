// tokens.ts — token-budget + number-format helpers used across the app.

// Rough token estimate (~4 chars/token) — good enough to budget the window.
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

// Compact number: 1232 → "1.2K", 1_200_000 → "1.2M"; below 1000 stays exact.
export const fmtCompact = (n: number) => {
  if (n < 1000) return n.toLocaleString();
  if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
};

// Parse a registry ctx string ("32K", "128K", "1M") into a token count.
export const ctxTokens = (ctx: string) =>
  ctx.trim().toUpperCase().endsWith("M") ? parseFloat(ctx) * 1e6 : parseFloat(ctx) * 1e3;
