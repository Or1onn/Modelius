// claudeModels.ts — current-gen Claude models for the app's Anthropic connection, sourced from
// the live /v1/models list (OAuth subscription or saved API key). Shared by the chat picker and
// the Code-mode native group so both reflect real, up-to-date models instead of a hardcoded set.
import { invoke } from "@tauri-apps/api/core";
import { cached, peek } from "@/shared/lib/modelCache";
import { hasKey } from "@/entities/session/model/keys";
import { hasAnthropicOAuth, getAnthropicAccessToken } from "@/entities/session/model/anthropicSession";
import { listModels, peekModels, type RemoteModel } from "@/entities/session/api/providerModels";

// Family derived generically from the id — drop the "claude" prefix and any numeric/version/date
// segments, leaving the alpha family word ("opus", "sonnet", "fable", …). No hardcoded list, so a
// new family (e.g. Fable) surfaces on its own. E.g. claude-opus-4-1-20250805 → "opus".
function familyOf(id: string): string {
  const fam = id
    .split("-")
    .filter((t) => t && t !== "claude" && !/^\d+(\.\d+)?$/.test(t))
    .join("-");
  return fam || id; // fall back to the whole id if nothing alpha remains
}

// Keep only the newest model per family — /v1/models is newest-first, so the first hit per family
// is current-gen. Trims the full catalog (prior generations like Opus 4.1) to one row each.
export function currentClaudeModels(models: RemoteModel[]): RemoteModel[] {
  const seen = new Set<string>();
  const out: RemoteModel[] = [];
  for (const m of models) {
    const fam = familyOf(m.id);
    if (seen.has(fam)) continue;
    seen.add(fam);
    out.push(m);
  }
  return out;
}

// Subscription models via the OAuth token (Rust proxies the call). Shares the "sub:anthropic"
// cache key with the chat picker's fetch so a connected account is listed only once.
async function fetchSubscriptionModels(): Promise<RemoteModel[]> {
  const token = await getAnthropicAccessToken();
  if (!token) return [];
  return cached("sub:anthropic", async () => {
    const json = await invoke<{ data?: { id: string; display_name?: string }[] }>("anthropic_list_models", {
      token,
      oauth: true,
    });
    return (json.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  });
}

// Current-gen Claude models for the app's Anthropic connection (OAuth over key), from /v1/models,
// deduped to the newest per family. Empty when neither is connected; callers fall back to static.
export async function listAppClaudeModels(): Promise<RemoteModel[]> {
  if (hasAnthropicOAuth()) return currentClaudeModels(await fetchSubscriptionModels().catch(() => []));
  if (hasKey("anthropic")) return currentClaudeModels(await listModels("anthropic").catch(() => []));
  return [];
}

// Sync cache mirror of listAppClaudeModels — null when cold/stale or nothing connected.
export function peekAppClaudeModels(): RemoteModel[] | null {
  if (hasAnthropicOAuth()) {
    const raw = peek<RemoteModel[]>("sub:anthropic");
    return raw ? currentClaudeModels(raw) : null;
  }
  if (hasKey("anthropic")) {
    const raw = peekModels("anthropic");
    return raw ? currentClaudeModels(raw) : null;
  }
  return null;
}
