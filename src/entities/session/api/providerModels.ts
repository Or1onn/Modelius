// providerModels.ts — fetch the real models available to a saved API key.
import { getKey } from "@/entities/session/model/keys";
import { cached, peek } from "@/shared/lib/modelCache";

export interface RemoteModel {
  id: string;
  name: string;
}

export async function listModels(provider: string): Promise<RemoteModel[]> {
  const key = getKey(provider);
  if (!key) throw new Error("No API key configured.");
  // Cache per key fingerprint so a different key doesn't serve stale models.
  return cached(`key:${provider}:${key.slice(-6)}`, () => fetchModels(provider, key));
}

// Synchronous cache peek for listModels — null if no key or the list is cold/stale.
export function peekModels(provider: string): RemoteModel[] | null {
  const key = getKey(provider);
  if (!key) return null;
  return peek<RemoteModel[]>(`key:${provider}:${key.slice(-6)}`);
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
