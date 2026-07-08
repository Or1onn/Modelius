// ollamaSession.ts — detect the local Ollama daemon + list installed models (OpenAI-compat /v1, CORS-free via Rust).
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";
import { cached, peek, put, evict } from "@/shared/lib/modelCache";
import { listCompatModels, type RemoteModel } from "@/entities/session/api/providerModels";

// Ollama serves an OpenAI-compatible API here; no key. Streaming/listing reuse the compat proxy.
export const OLLAMA_BASE = "http://localhost:11434/v1";
// Native API root (no /v1) — /api/show reports per-model capabilities the OpenAI-compat list
// omits. Also the Anthropic-compatible base Code mode points the claude CLI at (v0.14+).
export const OLLAMA_HOST = OLLAMA_BASE.replace(/\/v1\/?$/, "");
const CACHE_KEY = "ollama";
const CAP_KEY = "ollama:caps"; // Record<modelId, capabilities[]>

// GET /v1/models → installed models. Throws/empty when the daemon isn't running.
export async function listOllamaModels(): Promise<RemoteModel[]> {
  const models = await cached(CACHE_KEY, () => listCompatModels(OLLAMA_BASE, ""));
  void loadOllamaCapabilities(models); // warm the per-model capability cache (best-effort)
  return models;
}

// Capabilities array for one model from Ollama's native /api/show (e.g. ["completion","vision"]).
async function fetchCapabilities(model: string): Promise<string[]> {
  if (isTauri()) {
    const json = await invoke<{ capabilities?: string[] }>("ollama_show", { baseUrl: OLLAMA_HOST, model });
    return json.capabilities ?? [];
  }
  const res = await fetch(`${OLLAMA_HOST}/api/show`, { method: "POST", body: JSON.stringify({ model }) });
  return res.ok ? ((await res.json()).capabilities ?? []) : [];
}

// Fetch + cache each installed model's capabilities so vision support is known synchronously.
// Best-effort: a failed probe just leaves that model "unknown" (caller stays permissive).
export async function loadOllamaCapabilities(models: RemoteModel[]): Promise<void> {
  const caps: Record<string, string[]> = peek<Record<string, string[]>>(CAP_KEY) ?? {};
  let changed = false;
  await Promise.all(
    models.map(async (m) => {
      if (caps[m.id]) return; // already probed
      const c = await fetchCapabilities(m.id).catch(() => null);
      if (c) {
        caps[m.id] = c;
        changed = true;
      }
    })
  );
  if (changed) put(CAP_KEY, caps);
}

// Whether an installed model accepts images, from its cached capabilities. undefined until probed.
export function peekOllamaVision(id: string): boolean | undefined {
  const caps = peek<Record<string, string[]>>(CAP_KEY)?.[id];
  return caps ? caps.includes("vision") : undefined;
}

// Force a fresh probe — the daemon can start/stop between checks, so bust the cache first.
export async function refreshOllama(): Promise<RemoteModel[]> {
  evict(CACHE_KEY);
  evict(CAP_KEY);
  return listOllamaModels();
}

// Sync cache peek — null when never fetched / stale (daemon state unknown until a fetch runs).
export function peekOllamaModels(): RemoteModel[] | null {
  return peek<RemoteModel[]>(CACHE_KEY);
}

// True once a fetch has seen at least one installed model — drives routing-pool inclusion.
export function hasOllama(): boolean {
  return (peekOllamaModels()?.length ?? 0) > 0;
}
