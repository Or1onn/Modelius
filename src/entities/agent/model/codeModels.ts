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
import { listAppClaudeModels, peekAppClaudeModels } from "@/entities/session/api/claudeModels";
import { peekOllamaModels, listOllamaModels } from "@/entities/session/model/ollamaSession";
import { getGateways } from "@/entities/agent/model/gateways";
import { nativeChoice, protocolPairSupported, type CodeModelChoice } from "@/entities/agent/model/codeModel";

export interface CodeModelGroup {
  label: string;
  models: CodeModelChoice[];
}

// Providers the gateway can serve (OpenAI-compatible): OpenAI by key + every keyed compat provider.
const CONNECTED_IDS = ["openai", ...KEY_PROVIDER_IDS];

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
  claude: RemoteModel[] | null
): CodeModelGroup[] {
  const harness = HARNESS_BY_ID[harnessId];
  if (!harness) return [];

  const groups: CodeModelGroup[] = [];
  if (harness.native) {
    const native = harness.native;
    // The Anthropic native group uses the live /v1/models list when the app has an Anthropic
    // connection; otherwise the CLI's own login is authed independently, so fall back to static.
    const models = native.kind === "anthropic" && claude?.length ? claude : native.models();
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
  const gateways = getGateways().filter((g) => protocolPairSupported(harness.protocol, g.protocol ?? "anthropic"));
  if (gateways.length)
    groups.push({
      label: "Gateways" + VIA_GATEWAY,
      models: gateways.map((g) => ({ kind: "gateway", id: g.model, label: g.name, gatewayId: g.id })),
    });
  return groups;
}

const peekProvider = (pid: string): RemoteModel[] | null =>
  !hasKey(pid) ? null : pid === "openai" ? (peekModels("openai") ?? null) : peekKeyProviderModels(pid);

const listProvider = (pid: string): Promise<RemoteModel[] | null> =>
  !hasKey(pid)
    ? Promise.resolve(null)
    : pid === "openai"
      ? listModels("openai").catch(() => null)
      : listKeyProviderModels(pid).catch(() => null);

const nativeIsAnthropic = (harnessId: string): boolean => HARNESS_BY_ID[harnessId]?.native?.kind === "anthropic";

export function peekCodeModelGroups(harnessId: string): CodeModelGroup[] {
  const connected = Object.fromEntries(CONNECTED_IDS.map((pid) => [pid, peekProvider(pid)]));
  const claude = nativeIsAnthropic(harnessId) ? peekAppClaudeModels() : null;
  return buildGroups(harnessId, connected, peekOllamaModels(), claude);
}

export async function listCodeModelGroups(harnessId: string): Promise<CodeModelGroup[]> {
  const claude = nativeIsAnthropic(harnessId) ? await listAppClaudeModels().catch(() => null) : null;
  if (!HARNESS_BY_ID[harnessId]?.routable) return buildGroups(harnessId, {}, null, claude);
  const [ollama, ...lists] = await Promise.all([
    listOllamaModels().catch(() => null),
    ...CONNECTED_IDS.map((pid) => listProvider(pid)),
  ]);
  const connected = Object.fromEntries(CONNECTED_IDS.map((pid, i) => [pid, lists[i]]));
  return buildGroups(harnessId, connected, ollama, claude);
}
