// harnesses.ts — registry of agentic coding CLIs (the "Environment" axis of Code mode).
// Each harness is an external process the Rust `agent_run` command spawns; entries here must
// mirror the Rust spec table in src-tauri/src/harness.rs. `protocol` is the API dialect the CLI
// speaks when re-routed through the local gateway; `routable` says whether the CLI supports
// env-based endpoint override at all; `native` describes the CLI's own login (no routing).
import { LIVE_ANTHROPIC, LIVE_CODEX } from "@/entities/model/model/registry";

export interface HarnessModel {
  id: string; // passed to the CLI's --model flag
  name: string;
}

export type HarnessProtocol = "anthropic" | "openai";
export type NativeKind = "anthropic" | "codex";

export interface AgentHarness {
  id: string; // matches the Rust harness id in src-tauri/src/harness.rs
  name: string;
  bin: string; // executable name (shown in errors / the header tag)
  protocol: HarnessProtocol;
  routable: boolean;
  native?: { kind: NativeKind; label: string; models: () => HarnessModel[] };
}

export const HARNESSES: AgentHarness[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    bin: "claude",
    protocol: "anthropic",
    routable: true,
    native: {
      kind: "anthropic",
      label: "Anthropic",
      models: () => LIVE_ANTHROPIC.map((m) => ({ id: m.id, name: m.name })),
    },
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    protocol: "openai",
    routable: true, // native ChatGPT login, or route through the gateway to a bound model
    native: {
      kind: "codex",
      label: "ChatGPT (Codex)",
      models: () => LIVE_CODEX.map((m) => ({ id: m.id, name: m.name })),
    },
  },
];

export const HARNESS_BY_ID = Object.fromEntries(HARNESSES.map((h) => [h.id, h]));

// Permission modes shown in the picker (Claude Code semantics). Each harness maps them onto its
// own flags in the Rust spec table (src-tauri/src/harness.rs).
export interface PermissionMode {
  id: string;
  label: string;
}

// No "ask each time": the CLIs run headless (-p / exec), so they can't prompt — permission
// requests would be silently denied. Saved bodies with the old "default" mode are migrated
// to acceptEdits on load (codeChats.ts).
export const PERMISSION_MODES: PermissionMode[] = [
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan mode" },
  { id: "bypassPermissions", label: "Full auto" },
];

export const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(
  PERMISSION_MODES.map((m) => [m.id, m.label])
);
