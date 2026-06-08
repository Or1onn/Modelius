// backend.ts — value shapes shared across the streaming/routing features: the
// resolved live backend, a user-pickable model option, and the wire message types.

// A live backend resolved for a routing decision. "none" → nothing connected, so
// the caller falls back to the scripted demo answer.
export interface Backend {
  kind: "openai" | "chatgpt" | "anthropic" | "none";
  model: string;
  label?: string; // human model name, injected into the system prompt for self-id
}

// A manually selectable model, tied to a ready-to-use backend.
export interface ModelOption {
  key: string;
  label: string;
  provider: string;
  backend: Backend;
}

// A user image attachment carried alongside the text: base64 `data` (no data: prefix).
export interface ImagePart {
  mime: string;
  data: string;
}

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
  images?: ImagePart[];
}

// A streamed delta, tagged so the UI can separate reasoning from the answer.
// A "usage" delta arrives once at the end carrying real token counts; `metered`
// marks whether this turn is billed per-token (API key) vs a flat-fee subscription.
export type Delta =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number; metered: boolean };
