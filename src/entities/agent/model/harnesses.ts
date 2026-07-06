// harnesses.ts — registry of agentic coding CLIs (the "Environment" axis of Code mode).
// Each harness is an external process the Rust `agent_run` command spawns; `models` lists the
// models that harness can drive (many CLIs are tied to their provider). Claude Code first.
import { LIVE_ANTHROPIC } from "@/entities/model/model/registry";

export interface HarnessModel {
  id: string; // passed to the CLI's --model flag
  name: string;
}

export interface AgentHarness {
  id: string; // matches the Rust harness id in agent.rs build_argv
  name: string;
  bin: string; // executable name (shown in errors / the header tag)
  models: () => HarnessModel[];
}

export const HARNESSES: AgentHarness[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    bin: "claude",
    models: () => LIVE_ANTHROPIC.map((m) => ({ id: m.id, name: m.name })),
  },
];

export const HARNESS_BY_ID = Object.fromEntries(HARNESSES.map((h) => [h.id, h]));

// Permission modes passed to the harness CLI's --permission-mode flag (Claude Code semantics).
export interface PermissionMode {
  id: string;
  label: string;
}

export const PERMISSION_MODES: PermissionMode[] = [
  { id: "default", label: "Ask each time" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan mode" },
  { id: "bypassPermissions", label: "Full auto" },
];

export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(
  PERMISSION_MODES.map((m) => [m.id, m.label])
);
