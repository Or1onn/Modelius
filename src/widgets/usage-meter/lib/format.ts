// format.ts — shared formatters for the usage popovers (Chat's UsageMeter, Code's ContextRing).
import type { LimitWindow } from "@/entities/session/model/usageLimits";

export const fmtUsd = (n: number): string => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

// A plan window's used percent (0..100), when the utilization is known.
export const winUsedPct = (w: LimitWindow): number | null => (w.usedPct != null ? Math.round(w.usedPct * 100) : null);

// Reset time in Claude Code's phrasing: "Resets in 3 hr 23 min" within a day, "Resets Tue 6:00 PM"
// further out. undefined when the window carries no reset.
export function fmtReset(ms?: number): string | undefined {
  if (!ms) return undefined;
  const d = ms - Date.now();
  if (d <= 0) return "Resets now";
  if (d < 86_400_000) {
    const h = Math.floor(d / 3_600_000);
    const m = Math.round((d % 3_600_000) / 60_000);
    return h > 0 ? `Resets in ${h} hr ${m} min` : `Resets in ${Math.max(1, m)} min`;
  }
  const dt = new Date(ms);
  return `Resets ${dt.toLocaleDateString([], { weekday: "short" })} ${dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
