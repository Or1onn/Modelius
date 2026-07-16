// kimiModels.ts — live Kimi models from `kimi acp`'s session/new response: its configOptions
// advertise a "model" select whose options are the signed-in account's model catalog (there is
// no standalone model-list method in acp 0.25.0). Rust spawns a throwaway acp process
// (kimi_list_models); this caches the result (1h TTL) and maps it for the picker. Falls back to
// the hardcoded LIVE_KIMI when the CLI is missing or signed out (callers own the fallback).
import { invoke } from "@tauri-apps/api/core";
import { cached, peek } from "@/shared/lib/modelCache";

export interface KimiModel {
  id: string;
  name: string;
  isDefault: boolean;
}

// Raw session/new result (probe-verified 0.25.0): configOptions is a list of selects; the one
// with id "model" carries {currentValue, options:[{value, name}]}.
interface RawConfigOption {
  id?: string;
  currentValue?: string;
  options?: { value?: string; name?: string }[];
}

export function mapKimi(raw: unknown): KimiModel[] {
  const configOptions = (raw as { configOptions?: RawConfigOption[] } | null)?.configOptions;
  if (!Array.isArray(configOptions)) return [];
  const model = configOptions.find((o) => o?.id === "model");
  if (!model || !Array.isArray(model.options)) return [];
  return model.options
    .filter((o): o is { value: string; name?: string } => typeof o?.value === "string" && o.value.length > 0)
    .map((o) => ({
      id: o.value,
      name: o.name || o.value,
      isDefault: o.value === model.currentValue,
    }));
}

// Kimi auth is CLI-local (~/.kimi-code, no app-side OAuth) — one shared cache entry. The invoke
// fails fast when the bin is missing or signed out; errors propagate uncached so retries work.
const CACHE_KEY = "sub:kimi:local";

export async function listAppKimiModels(): Promise<KimiModel[]> {
  return cached(CACHE_KEY, async () => {
    const raw = await invoke<unknown>("kimi_list_models");
    return mapKimi(raw);
  });
}

// Sync cache mirror — null when cold/stale (instant render without a flash).
export function peekAppKimiModels(): KimiModel[] | null {
  return peek<KimiModel[]>(CACHE_KEY);
}
