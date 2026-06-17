// providerModels.ts — fetch the real models available to a saved API key.
import { invoke } from "@tauri-apps/api/core";
import { getKey, keyLast6 } from "@/entities/session/model/keys";
import { cached, peek } from "@/shared/lib/modelCache";
import { isTauri } from "@/shared/api/tauri";

export interface RemoteModel {
  id: string;
  name: string;
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
    return ((json.data || []) as { id: string; display_name?: string }[]).map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
    }));
  }

  throw new Error("Live model listing isn't supported for this provider yet.");
}

// Models from an OpenAI-compatible endpoint (custom provider). Rust proxy under Tauri
// (CORS-free); direct fetch in browser dev. No cache — called once from the add form.
export async function listCompatModels(baseUrl: string, key: string): Promise<RemoteModel[]> {
  let json: { data?: { id: string }[] };
  if (isTauri()) {
    json = await invoke<{ data?: { id: string }[] }>("compat_list_models", { baseUrl, apiKey: key });
  } else {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new Error(`Endpoint ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    json = await res.json();
  }
  return ((json.data || []) as { id: string }[])
    .map((m) => ({ id: m.id, name: m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
