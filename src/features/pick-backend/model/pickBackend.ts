// pickBackend.ts — pick a live backend for a decision + list user-pickable models by connection.
import { invoke } from "@tauri-apps/api/core";
import { MODELS, LIVE_ANTHROPIC, LIVE_CODEX, type Model, type Decision } from "@/entities/model/model/registry";
import type { Backend, ModelOption } from "@/entities/model/model/backend";
import {
  toOpenAIModel,
  toCodexModel,
  CODEX_MODELS,
  toAnthropicModel,
  claudeFamilyForCap,
  type ClaudeFamily,
} from "@/entities/model/model/apiIds";
import { TIER_WEIGHTS, type ModelTier } from "@/entities/model/lib/tiers";
import { blendedCostPer1K } from "@/entities/model/lib/pricing";
import { hasKey } from "@/entities/session/model/keys";
import { hasAnthropicOAuth, getAnthropicAccessToken } from "@/entities/session/model/anthropicSession";
import { hasOpenAIOAuth } from "@/entities/session/model/openaiSession";
import { hasOllama, peekOllamaModels, listOllamaModels, OLLAMA_BASE } from "@/entities/session/model/ollamaSession";
import {
  KEY_PROVIDER_BASE,
  KEY_PROVIDER_IDS,
  isKeyProvider,
  listKeyProviderModels,
  peekKeyProviderModels,
} from "@/entities/session/model/keyProviders";
import { listModels, peekModels, type RemoteModel } from "@/entities/session/api/providerModels";
import { cached, peek } from "@/shared/lib/modelCache";

// Messages API needs full ids — bare opus/sonnet/haiku aliases 404. Seeded with
// current gen, refreshed from /v1/models so the sync Auto path always has a real id.
const claudeIdByFamily: Record<ClaudeFamily, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function claudeFamilyOf(id: string): ClaudeFamily | null {
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return null;
}

// Keep only the newest model per family (assumes /v1/models is newest-first) to match the sub UI.
function currentClaudeModels(models: RemoteModel[]): RemoteModel[] {
  const seen = new Set<ClaudeFamily>();
  const out: RemoteModel[] = [];
  for (const m of models) {
    const fam = claudeFamilyOf(m.id);
    if (!fam || seen.has(fam)) continue;
    seen.add(fam);
    out.push(m);
  }
  return out;
}

// Claude models for the connected subscription, from /v1/models. Also refreshes
// claudeIdByFamily (first per family is current) so Auto routing sends a valid id.
async function fetchClaudeSubscriptionModels(): Promise<RemoteModel[]> {
  const token = await getAnthropicAccessToken();
  if (!token) return [];
  const models = await cached("sub:anthropic", async () => {
    const json = await invoke<{ data?: { id: string; display_name?: string }[] }>("anthropic_list_models", {
      token,
      oauth: true,
    });
    return (json.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  });
  // Refresh from the (possibly cached) list so Auto sends a valid id.
  for (const fam of ["opus", "sonnet", "haiku"] as ClaudeFamily[]) {
    const hit = models.find((m) => claudeFamilyOf(m.id) === fam);
    if (hit) claudeIdByFamily[fam] = hit.id;
  }
  return models;
}

// Cached current-gen Claude models for the sub, so Providers mirrors the picker. Empty if none.
export async function listClaudeAccountModels(): Promise<RemoteModel[]> {
  return currentClaudeModels(await fetchClaudeSubscriptionModels().catch(() => [] as RemoteModel[]));
}

// Sync cache peek mirroring listClaudeAccountModels — null if cold/stale (renders instantly, revalidates).
export function peekClaudeAccountModels(): RemoteModel[] | null {
  const raw = peek<RemoteModel[]>("sub:anthropic");
  return raw ? currentClaudeModels(raw) : null;
}

// Infer a routing tier from the parameter size in an Ollama id (llama3.3:70b, qwen2.5:14b, …);
// the endpoint reports no capability, so size is the only signal. Defaults to balanced.
function ollamaTier(id: string): ModelTier {
  const b = id.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  const params = b ? parseFloat(b[1]) : NaN;
  if (params >= 30) return "top";
  if (params >= 7) return "balanced";
  if (!Number.isNaN(params)) return "fast";
  return "balanced";
}

// Installed Ollama models as routable registry entries (free, local, tier → weights). Sync (cache peek).
export function ollamaRegistryModels(): Model[] {
  return (peekOllamaModels() ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    abbr: m.name.slice(0, 2),
    provider: "ollama",
    ...TIER_WEIGHTS[ollamaTier(m.id)],
    cost: 0, // local inference is free
    ctx: "128K", // conservative — Ollama doesn't report the window here
    local: true,
  }));
}

function ollamaOptions(models: RemoteModel[]): ModelOption[] {
  return models.map((m) => ({
    key: `ollama:${m.id}`,
    label: m.name,
    provider: "ollama",
    backend: { kind: "compat", model: m.id, label: m.name, baseUrl: OLLAMA_BASE, providerId: "ollama" },
  }));
}

// Key-provider (Gemini/Groq) tier from the model name — the catalog reports no capability.
function keyProviderTier(id: string): ModelTier {
  const s = id.toLowerCase();
  if (/pro|opus|ultra|405b|70b|72b/.test(s)) return "top";
  if (/flash|mini|lite|instant|nano|small|8b|9b|3b|1b/.test(s)) return "fast";
  return "balanced";
}

// A keyed provider's live models as routable entries: cap/spd/latency from the name tier (no
// published metric), but cost from the model's real per-token rate. Sync (cache peek).
function keyProviderRoutingModels(pid: string): Model[] {
  return (peekKeyProviderModels(pid) ?? []).map((m) => {
    const tier = TIER_WEIGHTS[keyProviderTier(m.id)];
    return {
      id: m.id,
      name: m.name,
      abbr: m.name.slice(0, 2),
      provider: pid,
      ...tier,
      cost: blendedCostPer1K(m.id) ?? tier.cost, // real rate when known
      ctx: pid === "google" ? "1M" : "128K",
      vision: pid === "google", // Gemini models accept images
    };
  });
}

function keyProviderOptions(pid: string, models: RemoteModel[]): ModelOption[] {
  return models.map((m) => ({
    key: `${pid}:${m.id}`,
    label: m.name,
    provider: pid,
    backend: { kind: "compat", model: m.id, label: m.name, baseUrl: KEY_PROVIDER_BASE[pid], providerId: pid },
  }));
}

// Compat backend on a keyed provider, mapping the routed pick to a real available model. null if no key/models.
function keyProviderBackend(pid: string, chosen: Model): Backend | null {
  if (!hasKey(pid)) return null;
  const models = peekKeyProviderModels(pid) ?? [];
  const real = models.find((m) => m.id === chosen.id) ?? models[0];
  if (!real) return null;
  return { kind: "compat", model: real.id, label: real.name, baseUrl: KEY_PROVIDER_BASE[pid], providerId: pid };
}

// Compat backend on the local daemon, mapping the routed pick to a real installed model
// (the demo registry's local ids aren't pullable). null when nothing is installed.
function ollamaBackend(chosen: Model): Backend | null {
  const installed = peekOllamaModels() ?? [];
  const real = installed.find((m) => m.id === chosen.id) ?? installed[0];
  if (!real) return null;
  return { kind: "compat", model: real.id, label: real.name, baseUrl: OLLAMA_BASE, providerId: "ollama" };
}

// User-pickable models by connection. ChatGPT account → curated Codex models (no
// list endpoint); else a live list (sub via /v1/models, key via listModels).
export async function listAvailableModels(): Promise<ModelOption[]> {
  const out: ModelOption[] = [];

  if (hasOpenAIOAuth()) {
    for (const m of CODEX_MODELS)
      out.push({ key: `chatgpt:${m.id}`, label: m.name, provider: "openai", backend: { kind: "chatgpt", model: m.id, label: m.name } });
  } else if (hasKey("openai")) {
    const models = await listModels("openai").catch(() => [] as RemoteModel[]);
    for (const m of models)
      out.push({ key: `openai:${m.id}`, label: m.name, provider: "openai", backend: { kind: "openai", model: m.id, label: m.name } });
  }

  // Prefer OAuth over key — matches streamClaude.
  if (hasAnthropicOAuth()) {
    const live = currentClaudeModels(await fetchClaudeSubscriptionModels().catch(() => [] as RemoteModel[]));
    // Fall back to current-gen ids if the list call is unavailable.
    const models = live.length
      ? live
      : (["opus", "sonnet", "haiku"] as ClaudeFamily[]).map((f) => ({
          id: claudeIdByFamily[f],
          name: `Claude ${f[0].toUpperCase()}${f.slice(1)}`,
        }));
    for (const m of models)
      out.push({ key: `anthropic:${m.id}`, label: m.name, provider: "anthropic", backend: { kind: "anthropic", model: m.id, label: m.name } });
  } else if (hasKey("anthropic")) {
    const models = await listModels("anthropic").catch(() => [] as RemoteModel[]);
    for (const m of models)
      out.push({ key: `anthropic:${m.id}`, label: m.name, provider: "anthropic", backend: { kind: "anthropic", model: m.id, label: m.name } });
  }

  for (const pid of KEY_PROVIDER_IDS)
    if (hasKey(pid)) out.push(...keyProviderOptions(pid, await listKeyProviderModels(pid).catch(() => [] as RemoteModel[])));
  out.push(...ollamaOptions(await listOllamaModels().catch(() => [] as RemoteModel[])));
  return out;
}

// Sync mirror of listAvailableModels from the cache — picker renders with no flash,
// async revalidates. Cold entries fall back (current-gen for a Claude account) so a
// connected provider never shows empty.
export function peekAvailableModels(): ModelOption[] {
  const out: ModelOption[] = [];

  if (hasOpenAIOAuth()) {
    for (const m of CODEX_MODELS)
      out.push({ key: `chatgpt:${m.id}`, label: m.name, provider: "openai", backend: { kind: "chatgpt", model: m.id, label: m.name } });
  } else if (hasKey("openai")) {
    for (const m of peekModels("openai") ?? [])
      out.push({ key: `openai:${m.id}`, label: m.name, provider: "openai", backend: { kind: "openai", model: m.id, label: m.name } });
  }

  if (hasAnthropicOAuth()) {
    const live = peekClaudeAccountModels();
    const models = live?.length
      ? live
      : (["opus", "sonnet", "haiku"] as ClaudeFamily[]).map((f) => ({
          id: claudeIdByFamily[f],
          name: `Claude ${f[0].toUpperCase()}${f.slice(1)}`,
        }));
    for (const m of models)
      out.push({ key: `anthropic:${m.id}`, label: m.name, provider: "anthropic", backend: { kind: "anthropic", model: m.id, label: m.name } });
  } else if (hasKey("anthropic")) {
    for (const m of peekModels("anthropic") ?? [])
      out.push({ key: `anthropic:${m.id}`, label: m.name, provider: "anthropic", backend: { kind: "anthropic", model: m.id, label: m.name } });
  }

  for (const pid of KEY_PROVIDER_IDS)
    if (hasKey(pid)) out.push(...keyProviderOptions(pid, peekKeyProviderModels(pid) ?? []));
  out.push(...ollamaOptions(peekOllamaModels() ?? []));
  return out;
}

// Prefer the chosen model's provider, else any connected one. "none" → nothing
// connected → caller falls back to demo. OAuth takes precedence over a key.
export function pickBackend(decision: Decision): Backend {
  const prov = decision.chosen.provider;
  const anthropicReady = hasKey("anthropic") || hasAnthropicOAuth();
  const openaiReady = hasKey("openai") || hasOpenAIOAuth();
  // label = human model name (prompt self-id + badge). ChatGPT answers with a curated
  // Codex id (not the routed pick), so name that.
  const openai = (): Backend => {
    if (hasOpenAIOAuth()) {
      const model = toCodexModel(decision.chosen);
      return { kind: "chatgpt", model, label: CODEX_MODELS.find((m) => m.id === model)?.name ?? model };
    }
    return { kind: "openai", model: toOpenAIModel(decision.chosen), label: decision.chosen.name };
  };
  // Sub resolves a real id per family; key uses the registry mapping. Non-Claude picks
  // map to a family by capability tier, so the routed difficulty survives the fallback.
  const anthropic = (): Backend => ({
    kind: "anthropic",
    model: hasAnthropicOAuth()
      ? claudeIdByFamily[claudeFamilyOf(decision.chosen.id) ?? claudeFamilyForCap(decision.chosen.cap)]
      : toAnthropicModel(decision.chosen),
    label: decision.chosen.name,
  });

  // A local (privacy/free) pick runs on the Ollama daemon, mapped to a real installed model.
  if (prov === "ollama") {
    const b = ollamaBackend(decision.chosen);
    if (b) return b;
  }
  // Gemini/Groq picks stream over their OpenAI-compatible endpoint with the saved key.
  if (isKeyProvider(prov)) {
    const b = keyProviderBackend(prov, decision.chosen);
    if (b) return b;
  }

  if (prov === "openai" && openaiReady) return openai();
  if (prov === "anthropic" && anthropicReady) return anthropic();
  if (openaiReady) return openai();
  if (anthropicReady) return anthropic();
  // Cross-provider fallback onto any keyed compat provider (Gemini/Groq).
  for (const pid of KEY_PROVIDER_IDS) {
    const b = keyProviderBackend(pid, decision.chosen);
    if (b) return b;
  }
  // Last resort: a local model if the daemon is up (covers a demo-registry local pick).
  const local = ollamaBackend(decision.chosen);
  if (local) return local;
  return { kind: "none", model: "" };
}

// Models the connected backends can actually serve — passed to route() as the live pool
// so the routed pick is real and difficulty drives the choice end-to-end. Empty → demo registry.
export function liveRoutingPool(): Model[] {
  const out: Model[] = [];
  if (hasOpenAIOAuth()) out.push(...LIVE_CODEX);
  else if (hasKey("openai")) out.push(...MODELS.filter((m) => m.provider === "openai"));
  if (hasAnthropicOAuth() || hasKey("anthropic")) out.push(...LIVE_ANTHROPIC);
  for (const pid of KEY_PROVIDER_IDS) if (hasKey(pid)) out.push(...keyProviderRoutingModels(pid)); // Gemini/Groq
  if (hasOllama()) out.push(...ollamaRegistryModels()); // local daemon detected → its installed models
  return out;
}

// Backend for cheap helper calls (summarization): prefer a flat-fee subscription
// (zero marginal cost) over a metered key, across providers — pickBackend only prefers
// OAuth within the routed provider. Falls back to cost-routed when no sub is connected.
export function pickSummarizerBackend(fallback: Decision): Backend {
  if (hasOpenAIOAuth()) {
    const m = CODEX_MODELS.find((c) => c.id.includes("mini")) ?? CODEX_MODELS[CODEX_MODELS.length - 1];
    return { kind: "chatgpt", model: m.id, label: m.name };
  }
  if (hasAnthropicOAuth()) return { kind: "anthropic", model: claudeIdByFamily.haiku, label: "Claude Haiku" };
  return pickBackend(fallback);
}
