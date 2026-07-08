// codeModel.ts — the Code-mode model selection. Native kinds ("anthropic"/"codex") run
// the CLI on its own login; "ollama"/"connected"/"gateway" re-route the CLI through the per-run
// local gateway (see src-tauri/src/gateway.rs) toward the picked endpoint. Which kinds fit which
// harness is derived from the harness registry (protocol/routable/native), not hardcoded.
// Secrets are never stored on the choice — only provider/gateway ids.
import { LIVE_ANTHROPIC, MODEL_BY_ID } from "@/entities/model/model/registry";
import { HARNESS_BY_ID, type HarnessProtocol, type NativeKind } from "@/entities/agent/model/harnesses";
import { getGateways, type GatewayProtocol } from "@/entities/agent/model/gateways";

export type CodeModelChoice =
  | { kind: "anthropic"; id: string; label: string }
  | { kind: "codex"; id: string; label: string }
  | { kind: "ollama"; id: string; label: string }
  | { kind: "connected"; id: string; label: string; providerId: string }
  | { kind: "gateway"; id: string; label: string; gatewayId: string };

export const DEFAULT_CODE_MODEL: CodeModelChoice = {
  kind: "anthropic",
  id: LIVE_ANTHROPIC[0].id,
  label: LIVE_ANTHROPIC[0].name,
};

// The one gateway pairing that isn't served yet: an OpenAI-protocol CLI can't drive an
// Anthropic-protocol endpoint (that translation direction is a future gateway feature).
export function protocolPairSupported(inbound: HarnessProtocol, outbound: GatewayProtocol): boolean {
  return !(inbound === "openai" && outbound === "anthropic");
}

export function nativeChoice(kind: NativeKind, id: string, label: string): CodeModelChoice {
  switch (kind) {
    case "anthropic":
      return { kind: "anthropic", id, label };
    case "codex":
      return { kind: "codex", id, label };
  }
}

export function choiceFitsHarness(choice: CodeModelChoice, harnessId: string): boolean {
  const h = HARNESS_BY_ID[harnessId];
  if (!h) return false;
  if (choice.kind === "anthropic" || choice.kind === "codex")
    return h.native?.kind === choice.kind;
  if (!h.routable) return false;
  if (choice.kind === "gateway") {
    const g = getGateways().find((g) => g.id === choice.gatewayId);
    return !!g && protocolPairSupported(h.protocol, g.protocol ?? "anthropic");
  }
  return true; // ollama / connected serve both inbound protocols
}

export function defaultModelForHarness(harnessId: string): CodeModelChoice {
  const h = HARNESS_BY_ID[harnessId];
  if (h?.native) {
    const m = h.native.models()[0];
    if (m) return nativeChoice(h.native.kind, m.id, m.name);
  }
  // Routable-only harness (no own login): first compatible gateway, else a placeholder the
  // send path rejects with a readable "pick a model" message.
  const g = h ? getGateways().find((g) => protocolPairSupported(h.protocol, g.protocol ?? "anthropic")) : undefined;
  if (g) return { kind: "gateway", id: g.model, label: g.name, gatewayId: g.id };
  return { kind: "connected", id: "", label: "Select model…", providerId: "" };
}

// Coerce a pre-routing saved body (bare modelId string) into a choice. Those bodies could only
// ever hold Anthropic picks, so kind is always "anthropic".
export function fromLegacyModelId(id: string): CodeModelChoice {
  return { kind: "anthropic", id, label: MODEL_BY_ID[id]?.name ?? id };
}

// Stable identity for picker checkmarks / setter no-op guards.
export function choiceKey(c: CodeModelChoice): string {
  if (c.kind === "gateway") return `gateway:${c.gatewayId}:${c.id}`;
  if (c.kind === "connected") return `connected:${c.providerId}:${c.id}`;
  return `${c.kind}:${c.id}`;
}

export function sameChoice(a: CodeModelChoice, b: CodeModelChoice): boolean {
  return choiceKey(a) === choiceKey(b);
}
