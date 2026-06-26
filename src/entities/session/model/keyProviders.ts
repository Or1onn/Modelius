// keyProviders.ts — providers reachable with just an API key over an OpenAI-compatible endpoint
// (Gemini, Groq). Listing/streaming reuse the compat proxy; the key is resolved per provider id.
import { cached, peek } from "@/shared/lib/modelCache";
import { getKey, keyLast6 } from "@/entities/session/model/keys";
import { listCompatModels, type RemoteModel } from "@/entities/session/api/providerModels";

// OpenAI-compatible roots. compat_chat_stream/compat_list_models append /chat/completions and /models.
export const KEY_PROVIDER_BASE: Record<string, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
export const KEY_PROVIDER_IDS = Object.keys(KEY_PROVIDER_BASE);

// Cache namespace — bump when the cached list's contents change (e.g. the OpenRouter cap was
// removed, so a previously-cached 40-item list must be dropped in favour of the full catalog).
const CACHE_V = "v2";

export function isKeyProvider(pid: string): boolean {
  return pid in KEY_PROVIDER_BASE;
}

// Drop non-chat entries the catalogs include (embeddings, audio, image, safety).
const NON_CHAT = /embed|whisper|tts|audio|imagen|image-generation|aqa|guard|moderation|rerank/i;

function normalize(models: RemoteModel[]): RemoteModel[] {
  return models
    .map((m) => ({ id: m.id.replace(/^models\//, ""), name: m.name.replace(/^models\//, "") })) // Gemini prefixes ids
    .filter((m) => !NON_CHAT.test(m.id));
}

export async function listKeyProviderModels(pid: string): Promise<RemoteModel[]> {
  const base = KEY_PROVIDER_BASE[pid];
  const key = await getKey(pid);
  if (!base || !key) return [];
  // Cache per key fingerprint (matches providerModels) so a changed key isn't served stale.
  // The full catalog (OpenRouter is 300+) is fetched once and cached; the UI reveals it in pages.
  return cached(`keyprov:${CACHE_V}:${pid}:${key.slice(-6)}`, async () => normalize(await listCompatModels(base, key)));
}

// Sync cache peek — null if no key or the list is cold/stale. Fingerprint from non-secret meta.
export function peekKeyProviderModels(pid: string): RemoteModel[] | null {
  const last6 = keyLast6(pid);
  if (!last6) return null;
  return peek<RemoteModel[]>(`keyprov:${CACHE_V}:${pid}:${last6}`);
}
