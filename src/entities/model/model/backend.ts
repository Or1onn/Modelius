// backend.ts — wire shapes shared across streaming/routing: resolved backend, model option, message types.

// A live backend for a routing decision. "none" → nothing connected (caller falls back to demo answer).
// "compat" = an OpenAI-compatible endpoint (Gemini/Groq via key, or local Ollama).
export interface Backend {
  kind: "openai" | "chatgpt" | "anthropic" | "compat" | "none";
  model: string;
  label?: string; // human model name, injected for self-id
  providerId?: string; // provider id whose stored key to use — compat only (omitted for keyless Ollama)
  baseUrl?: string; // compat only: the fixed endpoint root (e.g. Ollama, Gemini, Groq)
}

// Coarse account key a backend bills against — the key for its usage-limit/spend snapshot
// (entities/session/usageLimits). "chatgpt" (subscription) and "openai" (API key) are kept
// distinct because they have different limit surfaces (rate windows vs $ spend).
export function providerKeyForBackend(b: Backend): string {
  if (b.kind === "anthropic") return "anthropic";
  if (b.kind === "chatgpt") return "chatgpt";
  if (b.kind === "openai") return "openai";
  if (b.kind === "compat") return b.providerId ?? "compat";
  return "none";
}

// A manually selectable model, tied to a ready-to-use backend.
export interface ModelOption {
  key: string;
  label: string;
  provider: string;
  backend: Backend;
}

// A user image attachment: base64 `data` (no data: prefix).
export interface ImagePart {
  mime: string;
  data: string;
}

// Wire message replayed to a provider. Answer-only by design: no reasoning trace, so a
// mid-chat model switch can't feed one model another's (or its own) chain-of-thought. Keep it so.
export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
  images?: ImagePart[];
}

// A streamed delta, tagged so the UI can separate reasoning from the answer. The final
// "usage" delta carries real token counts; `metered` = billed per-token (key) vs flat-fee (sub).
export type Delta =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "image"; dataUrl: string } // a model-generated image (complete data URL) — image-output models
  | { kind: "stop"; reason: string } // why the model stopped (e.g. "max_tokens"/"length") — drives "Continue"
  | { kind: "usage"; inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; metered: boolean; cost?: number };
