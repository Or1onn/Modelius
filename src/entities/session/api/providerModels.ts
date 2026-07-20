// providerModels.ts — fetch the real models available to a saved API key.
import { invoke } from "@tauri-apps/api/core";
import { getKey, keyLast6 } from "@/entities/session/model/keys";
import { cached, peek } from "@/shared/lib/modelCache";
import { isTauri } from "@/shared/api/tauri";
import type { EffortLevel } from "@/entities/model/model/apiIds";

export interface RemoteModel {
  id: string;
  name: string;
  // Effort levels the provider advertises, when its model list carries capabilities (Anthropic
  // /v1/models). Empty array = explicitly unsupported; absent = the provider doesn't say.
  efforts?: EffortLevel[];
}

// capabilities.effort → the levels flagged supported, in menu order (probe-verified against
// /v1/models: `{supported, low:{supported}, medium:{…}, …}`). Ordering comes from this list, not
// from key order, and levels the API doesn't know are simply absent.
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export function effortsFromCapabilities(caps: unknown): EffortLevel[] {
  const effort = (caps as { effort?: Record<string, unknown> } | undefined)?.effort;
  if (effort?.supported !== true) return [];
  return EFFORT_ORDER.filter((l) => (effort[l] as { supported?: boolean } | undefined)?.supported === true);
}

export async function listModels(provider: string): Promise<RemoteModel[]> {
  const key = await getKey(provider);
  if (!key) throw new Error("No API key configured.");
  // Cache per key fingerprint so a different key doesn't serve stale models.
  return cached(`key:${provider}:${key.slice(-6)}`, () => fetchModels(provider, key));
}

// Sync cache peek — null if no key or list is cold/stale. Fingerprint from non-secret meta.
export function peekModels(provider: string): RemoteModel[] | null {
  const last6 = keyLast6(provider);
  if (!last6) return null;
  return peek<RemoteModel[]>(`key:${provider}:${last6}`);
}

async function fetchModels(provider: string, key: string): Promise<RemoteModel[]> {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = await res.json();
    return ((json.data || []) as { id: string }[])
      .map((m) => ({ id: m.id, name: m.id }))
      // Chat-capable models only — skip embeddings/audio/image/moderation.
      .filter((m) => /^(gpt-|o1|o3|o4|chatgpt)/.test(m.id) && !/(audio|realtime|transcribe|tts|image|search)/.test(m.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const json = await res.json();
    return ((json.data || []) as { id: string; display_name?: string; capabilities?: unknown }[]).map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      efforts: effortsFromCapabilities(m.capabilities),
    }));
  }

  throw new Error("Live model listing isn't supported for this provider yet.");
}

// Models from an OpenAI-compatible endpoint (custom provider). Rust proxy under Tauri
// (CORS-free); direct fetch in browser dev. No cache — called once from the add form.
export async function listCompatModels(baseUrl: string, key: string): Promise<RemoteModel[]> {
  let json: { data?: { id: string; name?: string }[] };
  if (isTauri()) {
    json = await invoke<{ data?: { id: string; name?: string }[] }>("compat_list_models", { baseUrl, apiKey: key });
  } else {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new Error(`Endpoint ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    json = await res.json();
  }
  // OpenRouter (and some compat endpoints) return a human `name` ("Anthropic: Claude 3.5 Sonnet");
  // fall back to the id for endpoints that only expose ids (e.g. Ollama, Groq).
  return ((json.data || []) as { id: string; name?: string }[])
    .map((m) => ({ id: m.id, name: m.name || m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
