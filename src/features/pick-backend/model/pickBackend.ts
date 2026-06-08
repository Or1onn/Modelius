// pickBackend.ts — pick a live backend for a routing decision, and list the
// models the user can pick explicitly, based on what's connected.
import { invoke } from "@tauri-apps/api/core";
import { type Decision } from "@/entities/model/model/registry";
import type { Backend, ModelOption } from "@/entities/model/model/backend";
import { toOpenAIModel, toCodexModel, CODEX_MODELS, toAnthropicModel } from "@/entities/model/model/apiIds";
import { hasKey } from "@/entities/session/model/keys";
import { hasAnthropicOAuth, getAnthropicAccessToken } from "@/entities/session/model/anthropicSession";
import { hasOpenAIOAuth } from "@/entities/session/model/openaiSession";
import { listModels, peekModels, type RemoteModel } from "@/entities/session/api/providerModels";
import { cached, peek } from "@/shared/lib/modelCache";

// The Messages API needs full model ids, not the bare opus/sonnet/haiku aliases
// (CLI-side only; the API 404s on them). Seeded with the current generation and
// refreshed from /v1/models so the sync Auto path always has a real id to send.
type ClaudeFamily = "opus" | "sonnet" | "haiku";
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

// /v1/models is the full API catalog (incl. legacy ids); keep only the newest
// model per family to match the subscription UI. Assumes newest-first ordering.
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

// Real Claude models for the connected subscription, from /v1/models. Also
// refreshes claudeIdByFamily (the list is newest-first, so the first per family
// is current) so Auto routing sends a valid id.
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
  // Refresh from the (possibly cached) list so Auto routing sends a valid id.
  for (const fam of ["opus", "sonnet", "haiku"] as ClaudeFamily[]) {
    const hit = models.find((m) => claudeFamilyOf(m.id) === fam);
    if (hit) claudeIdByFamily[fam] = hit.id;
  }
  return models;
}

// Live current-generation Claude models for the connected subscription (cached),
// so the Providers screen mirrors the chat picker. Empty if no account/list.
export async function listClaudeAccountModels(): Promise<RemoteModel[]> {
  return currentClaudeModels(await fetchClaudeSubscriptionModels().catch(() => [] as RemoteModel[]));
}

// Synchronous cache peek mirroring listClaudeAccountModels — null if cold/stale,
// so the Providers screen can render instantly and revalidate in the background.
export function peekClaudeAccountModels(): RemoteModel[] | null {
  const raw = peek<RemoteModel[]>("sub:anthropic");
  return raw ? currentClaudeModels(raw) : null;
}

// Models the user can pick explicitly, based on what's connected. A ChatGPT
// account exposes the curated Codex models (no list endpoint); everything else
// uses a real, live model list (subscription via /v1/models, key via listModels).
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

  // Prefer a connected account (OAuth) over a key — that's what streamClaude uses.
  if (hasAnthropicOAuth()) {
    const live = currentClaudeModels(await fetchClaudeSubscriptionModels().catch(() => [] as RemoteModel[]));
    // Fall back to the current-generation ids if the list call is unavailable.
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

  return out;
}

// Synchronous mirror of listAvailableModels built from the model cache — lets the
// picker render instantly with no loading flash; the async call then revalidates.
// Cold entries contribute nothing (key lists) or the current-generation fallback
// (a connected Claude account), so a connected provider never shows empty.
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

  return out;
}

// Prefer the chosen model's own provider; otherwise use any connected provider so
// something always answers. "none" → nothing connected → caller falls back to demo.
// For each provider a connected account (OAuth) takes precedence over an API key.
export function pickBackend(decision: Decision): Backend {
  const prov = decision.chosen.provider;
  const anthropicReady = hasKey("anthropic") || hasAnthropicOAuth();
  const openaiReady = hasKey("openai") || hasOpenAIOAuth();
  // label = human model name: injected into the prompt for self-id and shown on the
  // badge. ChatGPT answers with a curated Codex id (not the routed pick), so name that.
  const openai = (): Backend => {
    if (hasOpenAIOAuth()) {
      const model = toCodexModel(decision.chosen);
      return { kind: "chatgpt", model, label: CODEX_MODELS.find((m) => m.id === model)?.name ?? model };
    }
    return { kind: "openai", model: toOpenAIModel(decision.chosen), label: decision.chosen.name };
  };
  // A subscription needs a real id resolved per family (refreshed from /v1/models);
  // a key uses the registry mapping. Non-Claude picks default to sonnet.
  const anthropic = (): Backend => ({
    kind: "anthropic",
    model: hasAnthropicOAuth()
      ? claudeIdByFamily[claudeFamilyOf(decision.chosen.id) ?? "sonnet"]
      : toAnthropicModel(decision.chosen),
    label: decision.chosen.name,
  });

  if (prov === "openai" && openaiReady) return openai();
  if (prov === "anthropic" && anthropicReady) return anthropic();
  if (openaiReady) return openai();
  if (anthropicReady) return anthropic();
  return { kind: "none", model: "" };
}

// Backend for cheap helper calls (e.g. summarization): prefer a flat-fee
// subscription account — zero marginal cost — over a metered API key, across
// providers. `pickBackend` only prefers OAuth within the routed provider, so a
// "OpenAI key + Claude subscription" setup would otherwise pay per token here.
// Falls back to the normal cost-routed backend when no subscription is connected.
export function pickSummarizerBackend(fallback: Decision): Backend {
  if (hasOpenAIOAuth()) {
    const m = CODEX_MODELS.find((c) => c.id.includes("mini")) ?? CODEX_MODELS[CODEX_MODELS.length - 1];
    return { kind: "chatgpt", model: m.id, label: m.name };
  }
  if (hasAnthropicOAuth()) return { kind: "anthropic", model: claudeIdByFamily.haiku, label: "Claude Haiku" };
  return pickBackend(fallback);
}
