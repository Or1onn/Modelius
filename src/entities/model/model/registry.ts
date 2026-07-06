// registry.ts — model/provider registry + core routing value types (single source of truth).

export interface Provider {
  id: string;
  name: string;
  color: string;
  short: string;
  local: boolean;
}

export interface Model {
  id: string;
  name: string;
  abbr: string;
  provider: string;
  cost: number; // blended USD per 1K tokens
  cap: number; // capability 0..100
  spd: number; // speed 0..100
  latency: number;
  ctx: string;
  local?: boolean;
  vision?: boolean; // accepts images — routing requires it when an image is attached
}

export type PolicyId = "cost" | "quality" | "speed" | "privacy";

export interface Policy {
  id: PolicyId;
  label: string;
  blurb: string;
  icon: string;
}

// ----- Provider palette (tuned for dark UI) -----
export const PROVIDERS: Record<string, Provider> = {
  openai: { id: "openai", name: "OpenAI", color: "#10A37F", short: "OA", local: false },
  anthropic: { id: "anthropic", name: "Anthropic", color: "#D97757", short: "AN", local: false },
  google: { id: "google", name: "Google Gemini", color: "#4E8FF7", short: "GG", local: false },
  groq: { id: "groq", name: "Groq", color: "#F5A623", short: "GQ", local: false },
  openrouter: { id: "openrouter", name: "OpenRouter", color: "#6E56CF", short: "OR", local: false },
  ollama: { id: "ollama", name: "Ollama", color: "#8B7FF5", short: "OL", local: true },
};

// ----- Model registry -----
export const MODELS: Model[] = [
  { id: "gpt-4o", name: "GPT-4o", abbr: "4o", provider: "openai", cost: 0.005, cap: 94, spd: 70, latency: 1.2, ctx: "128K", vision: true },
  { id: "gpt-4o-mini", name: "GPT-4o mini", abbr: "4m", provider: "openai", cost: 0.00045, cap: 82, spd: 88, latency: 0.6, ctx: "128K", vision: true },
  { id: "o3", name: "o3", abbr: "o3", provider: "openai", cost: 0.02, cap: 97, spd: 40, latency: 4.1, ctx: "200K", vision: true },
  { id: "claude-opus-4", name: "Claude Opus 4", abbr: "Op", provider: "anthropic", cost: 0.018, cap: 98, spd: 55, latency: 2.4, ctx: "200K", vision: true },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", abbr: "Sn", provider: "anthropic", cost: 0.006, cap: 93, spd: 76, latency: 1.1, ctx: "200K", vision: true },
  { id: "claude-haiku-3-5", name: "Claude Haiku 3.5", abbr: "Hk", provider: "anthropic", cost: 0.001, cap: 80, spd: 90, latency: 0.5, ctx: "200K" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3 Pro", abbr: "Gp", provider: "google", cost: 0.0042, cap: 94, spd: 72, latency: 1.3, ctx: "1M", vision: true },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", abbr: "Gf", provider: "google", cost: 0.0003, cap: 84, spd: 93, latency: 0.4, ctx: "1M", vision: true },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", abbr: "Gp", provider: "google", cost: 0.0042, cap: 92, spd: 70, latency: 1.4, ctx: "1M", vision: true },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", abbr: "Gf", provider: "google", cost: 0.0003, cap: 82, spd: 92, latency: 0.4, ctx: "1M", vision: true },
  { id: "llama-3-3-70b", name: "Llama 3.3 70B", abbr: "L3", provider: "groq", cost: 0.0009, cap: 84, spd: 99, latency: 0.25, ctx: "128K" },
  { id: "mixtral-8x7b", name: "Mixtral 8x7B", abbr: "Mx", provider: "groq", cost: 0.0006, cap: 74, spd: 97, latency: 0.3, ctx: "32K" },
  { id: "llama-3-2-local", name: "Llama 3.2", abbr: "Lo", provider: "ollama", cost: 0, cap: 70, spd: 62, latency: 0.9, ctx: "128K", local: true },
  { id: "qwen-2-5-local", name: "Qwen 2.5 14B", abbr: "Qw", provider: "ollama", cost: 0, cap: 76, spd: 50, latency: 1.5, ctx: "32K", local: true },
];

// Live current-gen models for connected backends. liveRoutingPool() swaps these in for the
// demo registry above, so the routed pick is a model the backend can actually serve.
export const LIVE_ANTHROPIC: Model[] = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", abbr: "Op", provider: "anthropic", cost: 0.009, cap: 99, spd: 62, latency: 1.8, ctx: "200K", vision: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", abbr: "Sn", provider: "anthropic", cost: 0.006, cap: 94, spd: 80, latency: 0.9, ctx: "200K", vision: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", abbr: "Hk", provider: "anthropic", cost: 0.002, cap: 84, spd: 92, latency: 0.5, ctx: "200K", vision: true },
];
export const LIVE_CODEX: Model[] = [
  { id: "gpt-5.5", name: "GPT-5.5", abbr: "55", provider: "openai", cost: 0.007, cap: 97, spd: 68, latency: 1.4, ctx: "200K", vision: true },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", abbr: "5m", provider: "openai", cost: 0.001, cap: 84, spd: 90, latency: 0.6, ctx: "200K", vision: true },
];
export const MODEL_BY_ID: Record<string, Model> = Object.fromEntries(
  [...MODELS, ...LIVE_ANTHROPIC, ...LIVE_CODEX].map((m) => [m.id, m])
);

export const POLICIES: Record<PolicyId, Policy> = {
  cost: { id: "cost", label: "Cost", blurb: "Minimize spend — routes to the cheapest capable model", icon: "leaf" },
  quality: { id: "quality", label: "Quality", blurb: "Best output — uses top-tier models always", icon: "star" },
  speed: { id: "speed", label: "Speed", blurb: "Lowest latency — fastest responding models", icon: "bolt" },
  privacy: { id: "privacy", label: "Privacy", blurb: "Local only — no data leaves your machine", icon: "lock" },
};

export interface Classification {
  kind: "trivial" | "general" | "code" | "complex";
  label: string;
  difficulty?: number; // 0–100; absent on Decisions persisted before it existed
  confident?: boolean; // heuristic is sure → skip the LLM classifier (transient, routing-time)
}

export interface Candidate {
  model: Model;
  reqCost: number;
  score: number;
}

export interface Decision {
  classification: Classification;
  policy: PolicyId;
  tokens: number;
  chosen: Model;
  chosenCost: number;
  candidates: Candidate[];
  alternatives: { model: Model; reqCost: number }[];
  reason: string;
  baselineCost: number;
  saved: number;
  latency: number;
}

// Image on a user turn: `data` base64 for the API, `dataUrl` for the in-thread thumbnail.
export interface ImageRef {
  name: string;
  mime: string;
  data: string;
  dataUrl: string;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  images?: ImageRef[]; // vision input
  genImages?: string[]; // model-generated images (data URLs) — image-output models
  decision?: Decision;
  shown?: string;
  streaming?: boolean;
  reasoning?: string; // thinking trace, shown in a collapsible block
  // Set on a manual model pick — drives the header badge for off-registry models (e.g. Codex).
  modelLabel?: string;
  modelProvider?: string;
  memory?: string[]; // facts this turn added to memory ("Memory updated" note)
  // Real measured stats (vs the estimates in `decision`).
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number };
  latencyMs?: number; // wall-clock send → last token
  cost?: number; // real USD — metered turns only; absent on subscription/offline
  priceSource?: "live" | "table"; // where `cost`'s rate came from (OpenRouter live vs static table)
  ts?: number; // epoch ms when the turn was created (for the per-message timestamp)
  truncated?: boolean; // stream ended on a max-output-tokens cutoff → offer "Continue"
}
