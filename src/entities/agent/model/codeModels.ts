// codeModels.ts — grouped model list for the Code-mode picker, per harness, driven by the
// harness registry: a native group when the CLI has its own login, and (for routable CLIs)
// providers connected in the app, locally installed Ollama models, and user-configured gateways
// whose protocol the gateway proxy can serve. peek renders instantly; list revalidates the
// async sources.
import { HARNESS_BY_ID } from "@/entities/agent/model/harnesses";
import { PROVIDERS } from "@/entities/model/model/registry";
import { hasKey } from "@/entities/session/model/keys";
import { KEY_PROVIDER_IDS, listKeyProviderModels, peekKeyProviderModels } from "@/entities/session/model/keyProviders";
import { listModels, peekModels, type RemoteModel } from "@/entities/session/api/providerModels";
import { listAppClaudeModels, peekAppClaudeModels, currentClaudeModels } from "@/entities/session/api/claudeModels";
import { listAppCodexModels, peekAppCodexModels } from "@/entities/session/api/codexModels";
import { peekOllamaModels, listOllamaModels } from "@/entities/session/model/ollamaSession";
import { getGateways } from "@/entities/agent/model/gateways";
import { nativeChoice, type CodeModelChoice } from "@/entities/agent/model/codeModel";

export interface CodeModelGroup {
  label: string;
  models: CodeModelChoice[];
}

// Providers the gateway can serve by API key: OpenAI, Anthropic (both directions now translated by
// the local proxy), and every keyed compat provider (Gemini/Groq, OpenAI-compatible).
const CONNECTED_IDS = ["openai", "anthropic", ...KEY_PROVIDER_IDS];

// Non-native picks run the CLI through the local gateway proxy (protocol translation) — mark
// their group headers so the picker distinguishes them from the CLI's own well-trodden login.
const VIA_GATEWAY = " · via gateway";

function connectedGroup(pid: string, models: RemoteModel[] | null): CodeModelGroup | null {
  if (!models?.length) return null;
  return {
    label: (PROVIDERS[pid]?.name ?? pid) + VIA_GATEWAY,
    models: models.map((m) => ({ kind: "connected", id: m.id, label: m.name || m.id, providerId: pid })),
  };
}

function buildGroups(
  harnessId: string,
  connected: Record<string, RemoteModel[] | null>,
  ollama: RemoteModel[] | null,
  claude: RemoteModel[] | null,
  codex: RemoteModel[] | null
): CodeModelGroup[] {
  const harness = HARNESS_BY_ID[harnessId];
  if (!harness) return [];

  const groups: CodeModelGroup[] = [];
  if (harness.native) {
    const native = harness.native;
    // Native groups use the app's live subscription list when connected (Anthropic /v1/models,
    // Codex model/list); otherwise the CLI's own login is authed independently → static fallback.
    const models =
      native.kind === "anthropic" && claude?.length
        ? claude
        : native.kind === "codex" && codex?.length
          ? codex
          : native.models();
    groups.push({ label: native.label, models: models.map((m) => nativeChoice(native.kind, m.id, m.name)) });
  }
  if (!harness.routable) return groups;

  for (const pid of CONNECTED_IDS) {
    const g = connectedGroup(pid, connected[pid] ?? null);
    if (g) groups.push(g);
  }
  if (ollama?.length)
    groups.push({
      label: "Ollama (local)" + VIA_GATEWAY,
      models: ollama.map((m) => ({ kind: "ollama", id: m.id, label: m.name || m.id })),
    });
  const gateways = getGateways();
  if (gateways.length)
    groups.push({
      label: "Gateways" + VIA_GATEWAY,
      models: gateways.map((g) => ({ kind: "gateway", id: g.model, label: g.name, gatewayId: g.id })),
    });
  return groups;
}

const peekProvider = (pid: string): RemoteModel[] | null => {
  if (!hasKey(pid)) return null;
  if (pid === "openai") return peekModels("openai") ?? null;
  // Anthropic by key: current-gen Claude models from /v1/models (same filter Providers uses).
  if (pid === "anthropic") {
    const raw = peekModels("anthropic");
    return raw ? currentClaudeModels(raw) : null;
  }
  return peekKeyProviderModels(pid);
};

const listProvider = (pid: string): Promise<RemoteModel[] | null> => {
  if (!hasKey(pid)) return Promise.resolve(null);
  if (pid === "openai") return listModels("openai").catch(() => null);
  if (pid === "anthropic") return listModels("anthropic").then(currentClaudeModels).catch(() => null);
  return listKeyProviderModels(pid).catch(() => null);
};

const nativeIsAnthropic = (harnessId: string): boolean => HARNESS_BY_ID[harnessId]?.native?.kind === "anthropic";
const nativeIsCodex = (harnessId: string): boolean => HARNESS_BY_ID[harnessId]?.native?.kind === "codex";

export function peekCodeModelGroups(harnessId: string): CodeModelGroup[] {
  const connected = Object.fromEntries(CONNECTED_IDS.map((pid) => [pid, peekProvider(pid)]));
  const claude = nativeIsAnthropic(harnessId) ? peekAppClaudeModels() : null;
  const codex = nativeIsCodex(harnessId) ? peekAppCodexModels() : null;
  return buildGroups(harnessId, connected, peekOllamaModels(), claude, codex);
}

export async function listCodeModelGroups(harnessId: string): Promise<CodeModelGroup[]> {
  const claude = nativeIsAnthropic(harnessId) ? await listAppClaudeModels().catch(() => null) : null;
  const codex = nativeIsCodex(harnessId) ? await listAppCodexModels().catch(() => null) : null;
  if (!HARNESS_BY_ID[harnessId]?.routable) return buildGroups(harnessId, {}, null, claude, codex);
  const [ollama, ...lists] = await Promise.all([
    listOllamaModels().catch(() => null),
    ...CONNECTED_IDS.map((pid) => listProvider(pid)),
  ]);
  const connected = Object.fromEntries(CONNECTED_IDS.map((pid, i) => [pid, lists[i]]));
  return buildGroups(harnessId, connected, ollama, claude, codex);
}
