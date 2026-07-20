// effortSurface.ts — one answer to "does this pick have an effort knob, which levels, and what
// does Auto mean". Each provider answers from its own live catalog (Anthropic /v1/models
// capabilities, codex app-server model/list, OpenRouter's caps), falling back to a static set only
// while that catalog is cold. This reads the caches the model pickers already fill — it never
// fetches, so the effort knob can't drift from the model list next to it.
import {
  CODEX_EFFORT_LEVELS,
  CODEX_EFFORT_DEFAULT,
  EFFORT_LEVELS,
  resolveEffort,
  type EffortLevel,
} from "@/entities/model/model/apiIds";
import { supportsReasoning } from "@/entities/model/lib/pricingSource";
import { anthropicEffortInfo } from "@/entities/session/api/claudeModels";
import { peekAppCodexModels } from "@/entities/session/api/codexModels";

export interface EffortSurface {
  levels: EffortLevel[];
  dflt: EffortLevel; // what "auto" resolves to
}

// `provider` is a Code-mode model kind ("anthropic" | "codex" | "kimi" | "ollama" | "connected" |
// "gateway") or a Chat-mode provider id — both are plain strings and anything unknown gets no knob.
export function effortSurface(provider: string, model: string): EffortSurface | null {
  switch (provider) {
    case "anthropic":
      return anthropicEffortInfo(model);

    case "codex": {
      const live = peekAppCodexModels()?.find((m) => m.id === model);
      return {
        levels: live?.efforts.length ? live.efforts : CODEX_EFFORT_LEVELS,
        dflt: live?.defaultEffort ?? CODEX_EFFORT_DEFAULT,
      };
    }

    case "openrouter":
      // Reasoning models behind OpenRouter take low/medium/high. The catalog says which models
      // reason; one it doesn't know gets no knob (undefined → falsy).
      return supportsReasoning(model)
        ? { levels: EFFORT_LEVELS.sonnet, dflt: resolveEffort("sonnet", "auto") }
        : null;

    // kimi: unprobed, not unsupported. `kimi acp` answers session/new with
    // {code:-32000,"Authentication required"} until the user logs in, so whether its configOptions
    // carry a reasoning select is unknown. Wire it here once a signed-in probe shows the shape.
    default:
      return null;
  }
}

// Clamp a stored choice ("auto", or a level this model doesn't offer) to a concrete level.
export function pickEffort(surface: EffortSurface, v: EffortLevel | "auto"): EffortLevel {
  return v !== "auto" && surface.levels.includes(v) ? v : surface.dflt;
}
