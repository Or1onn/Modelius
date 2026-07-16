// codeModel.ts — the Code-mode model selection. Native kinds ("anthropic"/"codex"/"kimi") run
// the CLI on its own login; "ollama"/"connected"/"gateway" re-route the CLI through the per-run
// local gateway (see src-tauri/src/gateway.rs) toward the picked endpoint. Which kinds fit which
// harness is derived from the harness registry (protocol/routable/native), not hardcoded.
// Secrets are never stored on the choice — only provider/gateway ids.
import { LIVE_ANTHROPIC, MODEL_BY_ID } from "@/entities/model/model/registry";
import { HARNESS_BY_ID, type NativeKind } from "@/entities/agent/model/harnesses";
import { getGateways } from "@/entities/agent/model/gateways";
import { peekAppCodexModels } from "@/entities/session/api/codexModels";
import { peekAppKimiModels } from "@/entities/session/api/kimiModels";
import { ctxTokens } from "@/shared/lib/tokens";

export type CodeModelChoice =
  | { kind: "anthropic"; id: string; label: string }
  | { kind: "codex"; id: string; label: string }
  | { kind: "kimi"; id: string; label: string }
  | { kind: "ollama"; id: string; label: string }
  | { kind: "connected"; id: string; label: string; providerId: string }
  | { kind: "gateway"; id: string; label: string; gatewayId: string };

export const DEFAULT_CODE_MODEL: CodeModelChoice = {
  kind: "anthropic",
  id: LIVE_ANTHROPIC[0].id,
  label: LIVE_ANTHROPIC[0].name,
};

export function nativeChoice(kind: NativeKind, id: string, label: string): CodeModelChoice {
  switch (kind) {
    case "anthropic":
      return { kind: "anthropic", id, label };
    case "codex":
      return { kind: "codex", id, label };
    case "kimi":
      return { kind: "kimi", id, label };
  }
}

export function choiceFitsHarness(choice: CodeModelChoice, harnessId: string): boolean {
  const h = HARNESS_BY_ID[harnessId];
  if (!h) return false;
  if (choice.kind === "anthropic" || choice.kind === "codex" || choice.kind === "kimi")
    return h.native?.kind === choice.kind;
  if (!h.routable) return false;
  if (choice.kind === "gateway") {
    // Any gateway protocol now serves either inbound CLI protocol (the local proxy translates
    // both directions), so a gateway pick fits any routable harness it's still configured for.
    return getGateways().some((g) => g.id === choice.gatewayId);
  }
  return true; // ollama / connected serve both inbound protocols
}

export function defaultModelForHarness(harnessId: string): CodeModelChoice {
  const h = HARNESS_BY_ID[harnessId];
  if (h?.native) {
    // Codex: default to the account's live model/list (subscription-filtered) so the default
    // matches the dropdown — the hardcoded native.models() may lead with a plan-locked model
    // (e.g. gpt-5.6-sol) the live list hides. Fall back to static only when the cache is cold.
    if (h.native.kind === "codex") {
      const live = peekAppCodexModels();
      if (live?.length) {
        const m = live.find((x) => x.isDefault) ?? live[0];
        return nativeChoice("codex", m.id, m.name);
      }
    }
    // Kimi: same live-first rule — the CLI's own catalog (and its currentValue default) beats
    // the static guess once discovery has run.
    if (h.native.kind === "kimi") {
      const live = peekAppKimiModels();
      if (live?.length) {
        const m = live.find((x) => x.isDefault) ?? live[0];
        return nativeChoice("kimi", m.id, m.name);
      }
    }
    const m = h.native.models()[0];
    if (m) return nativeChoice(h.native.kind, m.id, m.name);
  }
  // Routable-only harness (no own login): first configured gateway (any protocol routes now),
  // else a placeholder the send path rejects with a readable "pick a model" message.
  const g = getGateways()[0];
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

// Context-window size (in tokens) for a Code-mode pick, for the context-fill ring. No model list or
// CLI event carries this, so: registry hit first (exact id), then per-family defaults matching what
// each CLI hardcodes internally. 0 = unknown → the ring shows "?" rather than a wrong denominator.
export function codeContextTokens(model: CodeModelChoice): number {
  const reg = MODEL_BY_ID[model.id];
  if (reg?.ctx) return ctxTokens(reg.ctx);
  const id = model.id.toLowerCase();
  // Opus is 1M; other Claude models 200K (unless an explicit 1M-context id).
  if (model.kind === "anthropic") return ctxTokens(id.includes("opus") || id.includes("[1m]") || id.includes("-1m") ? "1M" : "200K");
  if (model.kind === "codex") return ctxTokens("400K"); // gpt-5.x family
  if (model.kind === "kimi") return ctxTokens("256K"); // kimi k2.x family
  return 0; // connected / ollama / gateway — arbitrary third-party model, size unknown
}
