// ollamaSession.ts — detect the local Ollama daemon + list installed models (OpenAI-compat /v1, CORS-free via Rust).
import { cached, peek, evict } from "@/shared/lib/modelCache";
import { listCompatModels, type RemoteModel } from "@/entities/session/api/providerModels";

// Ollama serves an OpenAI-compatible API here; no key. Streaming/listing reuse the compat proxy.
export const OLLAMA_BASE = "http://localhost:11434/v1";
const CACHE_KEY = "ollama";

// GET /v1/models → installed models. Throws/empty when the daemon isn't running.
export async function listOllamaModels(): Promise<RemoteModel[]> {
  return cached(CACHE_KEY, () => listCompatModels(OLLAMA_BASE, ""));
}

// Force a fresh probe — the daemon can start/stop between checks, so bust the cache first.
export async function refreshOllama(): Promise<RemoteModel[]> {
  evict(CACHE_KEY);
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
