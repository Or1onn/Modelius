// usageLimits.ts — account-global usage snapshots per provider, shown by the Chat and Code usage
// meters. Two kinds of data: subscription rate-limit windows parsed from response headers
// (Claude/Codex logins), and API-key spend/balance in dollars. Fed by the stream adapters
// (recordLimits) and the cost accumulator (addSpend); balance is fetched on demand (refreshBalance).
// Figures are non-secret and persisted to localStorage — keys/tokens are never stored here.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getKey } from "@/entities/session/model/keys";
import { getAnthropicAccessToken } from "@/entities/session/model/anthropicSession";
import { getOpenAIAuth } from "@/entities/session/model/openaiSession";

export type ProviderKey = string; // "anthropic" | "chatgpt" | "openai" | compat providerId

export interface LimitWindow {
  label: string; // "Session (5h)" | "Weekly" | "Requests" | "Tokens"
  usedPct?: number; // 0..1
  remaining?: number;
  limit?: number;
  resetsAt?: number; // epoch ms
}

export interface LimitSnapshot {
  windows: LimitWindow[];
  status?: string; // "allowed" | "allowed_warning" | "rejected"
  balanceUsd?: { usage: number; limit: number | null };
  raw: Record<string, string>;
  at: number;
}

const LIMITS_KEY = "modelius.usageLimits";
const SPEND_KEY = "modelius.usageSpend";

const limits = new Map<ProviderKey, LimitSnapshot>();
const spend = new Map<ProviderKey, number>();
const chatProvider = new Map<string, ProviderKey>(); // chatId → last backend that answered (in-RAM)
const listeners = new Set<() => void>();

try {
  const l = JSON.parse(localStorage.getItem(LIMITS_KEY) || "{}") as Record<string, LimitSnapshot>;
  for (const [k, v] of Object.entries(l)) limits.set(k, v);
  const s = JSON.parse(localStorage.getItem(SPEND_KEY) || "{}") as Record<string, number>;
  for (const [k, v] of Object.entries(s)) spend.set(k, v);
} catch {
  /* ignore corrupt cache */
}

const emit = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const persistLimits = () => {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(Object.fromEntries(limits)));
  } catch {
    /* quota / private mode — the RAM copy still works this session */
  }
};
const persistSpend = () => {
  try {
    localStorage.setItem(SPEND_KEY, JSON.stringify(Object.fromEntries(spend)));
  } catch {
    /* ignore */
  }
};

// ---- header parsing ----

const num = (h: Record<string, string>, k: string): number | undefined => {
  const v = h[k];
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Reset headers come as an RFC3339 date, an absolute epoch (s or ms), or a relative duration
// ("30s" / "1m30s"). A bare epoch-seconds value (~1.75e9) must NOT be added to now — that pushes
// the reset ~55 years out (the "20650d" bug); only a small bare value is a seconds-from-now delta.
const resetMs = (v?: string): number | undefined => {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 1e12) return n; // already epoch milliseconds
    if (n >= 1e9) return n * 1000; // absolute epoch seconds
    return Date.now() + n * 1000; // small value = seconds from now
  }
  const dur = /^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/.exec(s);
  if (dur) return Date.now() + ((Number(dur[1]) || 0) * 60 + parseFloat(dur[2])) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

const mkWindow = (label: string, limit?: number, remaining?: number, reset?: number): LimitWindow | null => {
  if (limit == null && remaining == null && reset == null) return null;
  const usedPct = limit && limit > 0 && remaining != null ? Math.max(0, Math.min(1, 1 - remaining / limit)) : undefined;
  return { label, limit, remaining, usedPct, resetsAt: reset };
};

// Anthropic key/subscription family: "<prefix>-limit" / "-remaining" / "-reset".
const suffixWindow = (h: Record<string, string>, prefix: string, label: string): LimitWindow | null =>
  mkWindow(label, num(h, `${prefix}-limit`), num(h, `${prefix}-remaining`), resetMs(h[`${prefix}-reset`]));

// OpenAI family: "x-ratelimit-<field>-<type>" (field before type).
const openaiWindow = (h: Record<string, string>, type: string, label: string): LimitWindow | null =>
  mkWindow(label, num(h, `x-ratelimit-limit-${type}`), num(h, `x-ratelimit-remaining-${type}`), resetMs(h[`x-ratelimit-reset-${type}`]));

// Anthropic subscription (OAuth) unified windows use a utilization model, not limit/remaining:
// "anthropic-ratelimit-unified-<window>-utilization" is a 0..1 used-fraction, "-reset" its epoch.
// Windows are keyed by suffix ("5h", "7d", …); render whatever the API sends so a future premium
// window shows without a code change.
const UNIFIED_LABELS: Record<string, string> = { "5h": "5-hour limit", "7d": "Weekly · all models" };

function unifiedWindows(h: Record<string, string>): LimitWindow[] {
  const mk = (suffix: string): LimitWindow | null => {
    const util = num(h, `anthropic-ratelimit-unified-${suffix}-utilization`);
    const reset = resetMs(h[`anthropic-ratelimit-unified-${suffix}-reset`]);
    if (util == null && reset == null) return null;
    return { label: UNIFIED_LABELS[suffix] ?? suffix, usedPct: util != null ? Math.max(0, Math.min(1, util)) : undefined, resetsAt: reset };
  };
  const order = Object.keys(UNIFIED_LABELS);
  for (const k of Object.keys(h)) {
    const m = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(k);
    if (m && !order.includes(m[1])) order.push(m[1]);
  }
  return order.map(mk).filter((w): w is LimitWindow => w != null);
}

// Codex (ChatGPT subscription) windows: x-codex-<primary|secondary>-* headers. used-percent is an
// integer 0..100, reset-at is absolute epoch seconds, window-minutes sizes the label. An unused slot
// reports window-minutes 0 (skip it).
const codexLabel = (minutes: number): string => {
  if (minutes === 300) return "5-hour limit";
  if (minutes === 10080) return "Weekly limit";
  if (minutes === 43200) return "Monthly limit";
  const hrs = minutes / 60;
  return hrs < 24 ? `${Math.round(hrs)}-hour limit` : `${Math.round(hrs / 24)}-day limit`;
};

function codexWindows(h: Record<string, string>): LimitWindow[] {
  const mk = (slot: "primary" | "secondary"): LimitWindow | null => {
    const winMin = num(h, `x-codex-${slot}-window-minutes`);
    if (!winMin) return null; // unused slot
    const used = num(h, `x-codex-${slot}-used-percent`);
    const reset = resetMs(h[`x-codex-${slot}-reset-at`]) ?? resetMs(h[`x-codex-${slot}-reset-after-seconds`]);
    return { label: codexLabel(winMin), usedPct: used != null ? Math.max(0, Math.min(1, used / 100)) : undefined, resetsAt: reset };
  };
  return [mk("primary"), mk("secondary")].filter((w): w is LimitWindow => w != null);
}

// Normalize whatever rate-limit headers a provider sent into windows. Header names differ by
// provider/version — misses are fine (the raw set is kept for the popover fallback).
function parseWindows(h: Record<string, string>): LimitWindow[] {
  const out: (LimitWindow | null)[] = [
    // Anthropic API key windows.
    suffixWindow(h, "anthropic-ratelimit-requests", "Requests"),
    suffixWindow(h, "anthropic-ratelimit-tokens", "Tokens"),
    // OpenAI API key windows.
    openaiWindow(h, "requests", "Requests"),
    openaiWindow(h, "tokens", "Tokens"),
  ];
  return [...unifiedWindows(h), ...codexWindows(h), ...out.filter((w): w is LimitWindow => w != null)];
}

const RL_PREFIX = /^(anthropic-ratelimit|x-ratelimit|openai-)/;

// ---- mutations ----

export function recordLimits(key: ProviderKey, headers: Record<string, string>): void {
  const prev = limits.get(key);
  limits.set(key, {
    windows: parseWindows(headers),
    status: headers["anthropic-ratelimit-unified-status"] || headers["x-ratelimit-status"],
    balanceUsd: prev?.balanceUsd, // balance comes from a separate fetch — don't clobber it
    raw: headers,
    at: Date.now(),
  });
  persistLimits();
  emit();
}

// Capture from a browser fetch Response (OpenAI key / compat dev paths don't go through Rust).
export function recordLimitsFromHeaders(key: ProviderKey, headers: Headers): void {
  const h: Record<string, string> = {};
  headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (RL_PREFIX.test(lk)) h[lk] = v;
  });
  if (Object.keys(h).length) recordLimits(key, h);
}

export function addSpend(key: ProviderKey, usd: number): void {
  if (!(usd > 0) || key === "none") return;
  spend.set(key, (spend.get(key) ?? 0) + usd);
  persistSpend();
  emit();
}

export function setChatProvider(chatId: string, key: ProviderKey): void {
  if (chatProvider.get(chatId) === key) return;
  chatProvider.set(chatId, key);
  emit();
}
export function getChatProvider(chatId: string): ProviderKey | undefined {
  return chatProvider.get(chatId);
}

// Refresh a provider's usage when the meter opens: OpenRouter → real $ balance; Claude/Codex
// subscription → session/weekly windows via a direct authenticated request (the CLI hides response
// headers, so Code mode has no other source). Throttled per provider so opening the popover
// repeatedly doesn't spam the endpoint. `model` is the chat's model id (needed for the subscription
// probe). No-op for API-key providers, which populate from real streams.
const lastFetch: Record<ProviderKey, number> = {};
const FETCH_TTL = 120_000;

async function fetchBalance(): Promise<void> {
  try {
    const apiKey = await getKey("openrouter");
    if (!apiKey) return;
    const r = await invoke<{ data?: { usage?: number; limit?: number | null } }>("openrouter_key_status", { key: apiKey });
    const d = r?.data;
    if (!d) return;
    const prev = limits.get("openrouter");
    limits.set("openrouter", {
      windows: prev?.windows ?? [],
      status: prev?.status,
      balanceUsd: { usage: d.usage ?? 0, limit: d.limit ?? null },
      raw: prev?.raw ?? {},
      at: Date.now(),
    });
    persistLimits();
    emit();
  } catch {
    /* balance is best-effort */
  }
}

// In-flight probes, so the popover can show a "Loading…" placeholder instead of an empty section
// during the ~3-4s round-trip (and not look broken before values arrive).
const fetching = new Set<ProviderKey>();
const setFetching = (key: ProviderKey, on: boolean): void => {
  if (fetching.has(key) === on) return;
  if (on) fetching.add(key);
  else fetching.delete(key);
  emit();
};

export async function refreshUsage(key: ProviderKey | undefined, model?: string): Promise<void> {
  if (!key) return;
  const now = Date.now();
  if (now - (lastFetch[key] ?? 0) < FETCH_TTL) return;

  if (key === "openrouter") {
    lastFetch[key] = now;
    setFetching(key, true);
    try {
      await fetchBalance();
    } finally {
      setFetching(key, false);
    }
    return;
  }
  if (key === "anthropic" && model) {
    const token = await getAnthropicAccessToken();
    if (!token) return; // API-key-only account: limits come from real streams, not this probe
    lastFetch[key] = now;
    setFetching(key, true);
    try {
      const headers = await invoke<Record<string, string>>("anthropic_usage", { token, model });
      if (Object.keys(headers).length) recordLimits("anthropic", headers);
    } catch {
      /* best-effort */
    } finally {
      setFetching(key, false);
    }
    return;
  }
  if (key === "chatgpt" && model) {
    const auth = await getOpenAIAuth();
    if (!auth) return;
    lastFetch[key] = now;
    setFetching(key, true);
    try {
      const headers = await invoke<Record<string, string>>("chatgpt_usage", { token: auth.token, accountId: auth.accountId, model });
      if (Object.keys(headers).length) recordLimits("chatgpt", headers);
    } catch {
      /* best-effort */
    } finally {
      setFetching(key, false);
    }
  }
}

// ---- reads ----

export function useUsageLimits(key: ProviderKey | undefined): LimitSnapshot | undefined {
  return useSyncExternalStore(subscribe, () => (key ? limits.get(key) : undefined));
}
export function useUsageFetching(key: ProviderKey | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (key ? fetching.has(key) : false));
}
export function useSpend(key: ProviderKey | undefined): number {
  return useSyncExternalStore(subscribe, () => (key ? spend.get(key) ?? 0 : 0));
}
export function useChatProvider(chatId: string): ProviderKey | undefined {
  return useSyncExternalStore(subscribe, () => chatProvider.get(chatId));
}
