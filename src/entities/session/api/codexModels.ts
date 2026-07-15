// codexModels.ts — live Codex (ChatGPT subscription) models from `codex app-server`'s model/list,
// the subscription-filtered set the CLI's `/model` shows (so a free/Plus account never sees a
// Pro-only model like gpt-5.6-sol). Rust spawns a throwaway app-server (codex_list_models); this
// caches the result (1h TTL, per account) and maps it for the pickers + effort tiers. Falls back
// to the hardcoded CODEX_MODELS/LIVE_CODEX when cold/offline (callers own the fallback).
import { invoke } from "@tauri-apps/api/core";
import { cached, peek } from "@/shared/lib/modelCache";
import { hasOpenAIOAuth, openaiAccountId, getCodexAuth } from "@/entities/session/model/openaiSession";
import type { EffortLevel } from "@/entities/model/model/apiIds";

export interface CodexModel {
  id: string;
  name: string;
  vision: boolean;
  isDefault: boolean;
  efforts: EffortLevel[];
  defaultEffort: EffortLevel;
}

const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max", "ultra"]);
const asEffort = (s: unknown): EffortLevel | null =>
  typeof s === "string" && EFFORTS.has(s as EffortLevel) ? (s as EffortLevel) : null;

// Raw model/list entry (the fields we read — see probe-out/p7.jsonl).
interface RawCodexModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  upgrade?: unknown;
  upgradeInfo?: unknown;
  inputModalities?: string[];
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort?: string }[];
}

// Map the raw `{data:[…]}` result to picker entries, dropping plan-locked models (hidden, or the
// server marks an upgrade path — not runnable on this plan).
export function mapCodex(raw: { data?: RawCodexModel[] }): CodexModel[] {
  return (raw.data || [])
    .filter((m) => m.id && !m.hidden && !m.upgrade && !m.upgradeInfo)
    .map((m) => {
      const efforts = (m.supportedReasoningEfforts || [])
        .map((e) => asEffort(e.reasoningEffort))
        .filter((e): e is EffortLevel => e !== null);
      return {
        id: m.id,
        name: m.displayName || m.id,
        vision: (m.inputModalities || []).includes("image"),
        isDefault: !!m.isDefault,
        efforts,
        defaultEffort: asEffort(m.defaultReasoningEffort) ?? "medium",
      };
    });
}

const cacheKey = () => `sub:codex:${openaiAccountId()}`;

// Live Codex models for the connected account, cached per account. Empty when no ChatGPT account
// is connected (callers fall back to the static set). Errors propagate uncached so retries work.
export async function listAppCodexModels(): Promise<CodexModel[]> {
  if (!hasOpenAIOAuth()) return [];
  const auth = await getCodexAuth().catch(() => null);
  if (!auth) return [];
  return cached(cacheKey(), async () => {
    const raw = await invoke<{ data?: RawCodexModel[] }>("codex_list_models", { codexAuth: auth });
    return mapCodex(raw);
  });
}

// Sync cache mirror — null when cold/stale or nothing connected (instant render without a flash).
export function peekAppCodexModels(): CodexModel[] | null {
  if (!hasOpenAIOAuth()) return null;
  return peek<CodexModel[]>(cacheKey());
}
