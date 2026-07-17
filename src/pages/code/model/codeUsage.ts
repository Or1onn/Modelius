// codeUsage.ts — real usage statistics for the Code empty-state hero, aggregated from stored
// code sessions. Tokens aren't persisted per turn, so "tokens" is estimated from the transcript
// text (estimateTokens); everything else is exact: session counts, active-day streaks derived from
// timestamps, favorite model from each body's saved modelId. Bodies are loaded once and cached.
import { useEffect, useState } from "react";
import { getCodeChats, loadCodeBody } from "@/entities/agent/model/codeChats";
import type { UIMessage } from "ai";
import { estimateTokens } from "@/shared/lib/tokens";

export interface UsageSession {
  createdAt: number;
  modelId: string;
  msgs: number; // user turns
  tokens: number; // estimated from transcript text
}

export type RangeId = "All" | "30d" | "7d";

// Concatenate the human-visible text of a transcript for a rough token estimate.
function messagesText(messages: UIMessage[]): string {
  const out: string[] = [];
  for (const m of messages)
    for (const p of m.parts as any[]) {
      if (p.type === "text" && typeof p.text === "string") out.push(p.text);
      else if (p.type === "dynamic-tool") {
        if (p.input) out.push(JSON.stringify(p.input));
        if (typeof p.output === "string") out.push(p.output);
      }
    }
  return out.join("\n");
}

// ---- module-level cache (bodies loaded once per session) ----
let cache: UsageSession[] | null = null;
let inflight: Promise<UsageSession[]> | null = null;

async function loadUsage(): Promise<UsageSession[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const chats = getCodeChats();
    const rows = await Promise.all(
      chats.map(async (c) => {
        const body = await loadCodeBody(c.id);
        const messages = body?.messages ?? [];
        return {
          createdAt: c.createdAt,
          modelId: body?.modelId ?? "",
          msgs: messages.filter((m) => m.role === "user").length,
          tokens: estimateTokens(messagesText(messages)),
        };
      })
    );
    cache = rows;
    inflight = null;
    return rows;
  })();
  return inflight;
}

// Invalidate after a run persists, so the hero reflects the latest session next time it opens.
export function invalidateCodeUsage(): void {
  cache = null;
  inflight = null;
}

export function useCodeUsage(): { sessions: UsageSession[]; loading: boolean } {
  const [sessions, setSessions] = useState<UsageSession[]>(cache ?? []);
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    let alive = true;
    void loadUsage().then((rows) => {
      if (!alive) return;
      setSessions(rows);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);
  return { sessions, loading };
}

// ---- derived metrics ----

const DAY = 86_400_000;
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function withinRange(sessions: UsageSession[], range: RangeId): UsageSession[] {
  if (range === "All") return sessions;
  const cutoff = Date.now() - (range === "7d" ? 7 : 30) * DAY;
  return sessions.filter((s) => s.createdAt >= cutoff);
}

// Longest and current consecutive-day streaks from a set of active calendar days.
function streaks(days: Set<string>): { current: number; longest: number } {
  if (!days.size) return { current: 0, longest: 0 };
  const has = (t: number) => days.has(dayKey(t));
  // current: run of days ending today or yesterday (a day in progress shouldn't break it)
  let current = 0;
  let anchor = has(Date.now()) ? Date.now() : Date.now() - DAY;
  if (has(anchor)) { while (has(anchor)) { current++; anchor -= DAY; } }
  // longest: scan sorted unique day timestamps
  const ts = [...days].map((k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m, d).getTime(); }).sort((a, b) => a - b);
  let longest = 1, run = 1;
  for (let i = 1; i < ts.length; i++) {
    run = Math.round((ts[i] - ts[i - 1]) / DAY) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

const fmtInt = (n: number) => n.toLocaleString();
export const fmtTokens = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);
const fmtHour = (h: number) => { const am = h < 12; const h12 = h % 12 || 12; return `${h12} ${am ? "AM" : "PM"}`; };

export interface HeroStats {
  Sessions: string;
  Messages: string;
  "Total tokens": string;
  "Active days": string;
  "Current streak": string;
  "Longest streak": string;
  "Peak hour": string;
  "Favorite model": string;
}

export const STAT_ORDER: (keyof HeroStats)[] = [
  "Sessions", "Messages", "Total tokens", "Active days",
  "Current streak", "Longest streak", "Peak hour", "Favorite model",
];

export function computeStats(sessions: UsageSession[], range: RangeId, modelName: (id: string) => string): HeroStats {
  const rows = withinRange(sessions, range);
  const totalTokens = rows.reduce((a, s) => a + s.tokens, 0);
  const days = new Set(rows.map((s) => dayKey(s.createdAt)));
  const { current, longest } = streaks(days);

  // peak hour: modal hour-of-day across sessions
  const hours = new Array(24).fill(0);
  for (const s of rows) hours[new Date(s.createdAt).getHours()]++;
  const peak = hours.some((h) => h > 0) ? hours.indexOf(Math.max(...hours)) : -1;

  // favorite model: most-used modelId
  const byModel: Record<string, number> = {};
  for (const s of rows) if (s.modelId) byModel[s.modelId] = (byModel[s.modelId] || 0) + 1;
  const fav = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    Sessions: fmtInt(rows.length),
    Messages: fmtInt(rows.reduce((a, s) => a + s.msgs, 0)),
    "Total tokens": fmtTokens(totalTokens),
    "Active days": fmtInt(days.size),
    "Current streak": current ? current + "d" : "—",
    "Longest streak": longest ? longest + "d" : "—",
    "Peak hour": peak >= 0 ? fmtHour(peak) : "—",
    "Favorite model": fav ? modelName(fav) : "—",
  };
}

export interface ModelUsage { id: string; tokens: string; pct: number }

export function computeModelUsage(sessions: UsageSession[], range: RangeId): ModelUsage[] {
  const rows = withinRange(sessions, range);
  const total = rows.reduce((a, s) => a + s.tokens, 0) || 1;
  const byModel: Record<string, number> = {};
  for (const s of rows) if (s.modelId) byModel[s.modelId] = (byModel[s.modelId] || 0) + s.tokens;
  return Object.entries(byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([id, tok]) => ({ id, tokens: fmtTokens(tok), pct: Math.round((tok / total) * 100) }));
}

// GitHub-style contribution grid: 7 rows (weekday) × 30 columns (weeks), rightmost = this week.
// Level 0 = no session that day, 1 = one, 2 = two or more.
export function computeHeat(sessions: UsageSession[], range: RangeId): number[][] {
  const rows = withinRange(sessions, range);
  const count: Record<string, number> = {};
  for (const s of rows) count[dayKey(s.createdAt)] = (count[dayKey(s.createdAt)] || 0) + 1;
  const cols = 30, rowsN = 7;
  const now = new Date();
  const mondayIdx = (now.getDay() + 6) % 7; // 0 = Monday
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayIdx).getTime();
  const grid: number[][] = [];
  for (let r = 0; r < rowsN; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const t = startOfWeek - (cols - 1 - c) * 7 * DAY + r * DAY;
      const n = count[dayKey(t)] || 0;
      row.push(n >= 2 ? 2 : n === 1 ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

// Playful footer comparing token spend to Animal Farm (~39K tokens).
export function usageFoot(sessions: UsageSession[], range: RangeId): string | null {
  const total = withinRange(sessions, range).reduce((a, s) => a + s.tokens, 0);
  if (total < 39_000) return null;
  return `You've used ~${Math.round(total / 39_000)}× more tokens than Animal Farm.`;
}
