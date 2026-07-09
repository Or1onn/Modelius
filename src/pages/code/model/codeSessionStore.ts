// codeSessionStore.ts — global per-code-chat session state + agent-run orchestration.
// Mirrors pages/chat/model/sessionStore.ts, stripped to Code mode: the run streams transcript
// Steps (not text Deltas) via runAgentToSteps. Streaming runs at module scope so a run survives a
// chat/screen switch; CodeScreen subscribes via useCodeSession and renders.
import { useCallback, useSyncExternalStore } from "react";
import { HARNESSES, HARNESS_BY_ID } from "@/entities/agent/model/harnesses";
import {
  DEFAULT_CODE_MODEL,
  sameChoice,
  choiceFitsHarness,
  defaultModelForHarness,
  type CodeModelChoice,
} from "@/entities/agent/model/codeModel";
import { getGateways, gatewaySecretKey } from "@/entities/agent/model/gateways";
import { OLLAMA_HOST } from "@/entities/session/model/ollamaSession";
import { getCodexAuth } from "@/entities/session/model/openaiSession";
import { getAnthropicAccessToken } from "@/entities/session/model/anthropicSession";
import { getKey } from "@/entities/session/model/keys";
import { KEY_PROVIDER_BASE } from "@/entities/session/model/keyProviders";
import { secretGet } from "@/shared/api/secrets";
import { runAgentToSteps, applyDelta, type Step } from "@/features/run-agent/lib/agentChannel";
import { getCodeChats, loadCodeBody, saveCodeBody, upsertCodeChat, codeIndexEntryFrom } from "@/entities/agent/model/codeChats";
import { invalidateCodeUsage } from "@/pages/code/model/codeUsage";

type Phase = "idle" | "running";

// Default harness (used for a fresh session, before any saved body loads).
const DEFAULT_HARNESS = HARNESSES[0].id;

// Immutable view the component subscribes to (re-created per commit).
export interface CodeSessionView {
  steps: Step[];
  phase: Phase;
  cwd: string;
  harnessId: string;
  model: CodeModelChoice;
  permissionMode: string;
  contextTokens: number; // prompt tokens of the last turn (context-window fill); 0 until first result
  cost: number | null; // cumulative USD reported by the last result
  loading: boolean; // saved body still being fetched
}

interface CodeSession {
  chatId: string;
  steps: Step[];
  phase: Phase;
  cwd: string;
  harnessId: string;
  model: CodeModelChoice;
  permissionMode: string;
  contextTokens: number;
  cost: number | null;
  // The harness CLI's own session id from the last run — passed back as `resume` so the next
  // turn continues the same CLI session (multi-turn memory). Belongs to the current harness.
  resumeId: string | null;
  title: string;
  loading: boolean;
  createdAt: number;
  dirty: boolean; // set on first user action; gates persistence
  saveTimer: number | null;
  abort: AbortController | null;
  listeners: Set<() => void>;
  view: CodeSessionView;
}

const codeSessions = new Map<string, CodeSession>();

function rebuildView(s: CodeSession): void {
  s.view = {
    steps: s.steps,
    phase: s.phase,
    cwd: s.cwd,
    harnessId: s.harnessId,
    model: s.model,
    permissionMode: s.permissionMode,
    contextTokens: s.contextTokens,
    cost: s.cost,
    loading: s.loading,
  };
}

function commit(s: CodeSession): void {
  rebuildView(s);
  s.listeners.forEach((fn) => fn());
  schedulePersist(s);
}

function schedulePersist(s: CodeSession): void {
  if (!s.dirty || s.phase !== "idle") return; // don't persist mid-run/seed-only
  if (s.saveTimer) clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => {
    s.saveTimer = null;
    const entry = codeIndexEntryFrom(s.chatId, s.steps, s.createdAt, s.title, s.cwd);
    if (!entry) return; // no user turn yet — nothing to index
    void saveCodeBody(s.chatId, {
      steps: s.steps,
      cwd: s.cwd,
      harnessId: s.harnessId,
      modelId: s.model.id, // legacy field, kept for older builds
      model: s.model,
      permissionMode: s.permissionMode,
      resumeId: s.resumeId ?? undefined,
      contextTokens: s.contextTokens,
      cost: s.cost,
      title: s.title,
    });
    upsertCodeChat(entry);
    invalidateCodeUsage(); // hero stats recompute next time the empty state opens
  }, 400) as unknown as number;
}

function ensure(chatId: string): CodeSession {
  let s = codeSessions.get(chatId);
  if (s) return s;
  const known = getCodeChats().some((c) => c.id === chatId);
  s = {
    chatId,
    steps: [],
    phase: "idle",
    cwd: "",
    harnessId: DEFAULT_HARNESS,
    model: DEFAULT_CODE_MODEL,
    permissionMode: "acceptEdits",
    contextTokens: 0,
    cost: null,
    resumeId: null,
    title: "",
    loading: known,
    createdAt: Date.now(),
    dirty: false,
    saveTimer: null,
    abort: null,
    listeners: new Set(),
    view: null as unknown as CodeSessionView,
  };
  rebuildView(s);
  codeSessions.set(chatId, s);
  void load(s);
  return s;
}

// Load the saved body once, guarding against clobbering an in-flight run (load may resolve late).
async function load(s: CodeSession): Promise<void> {
  const existing = getCodeChats().find((c) => c.id === s.chatId);
  if (existing) s.createdAt = existing.createdAt;
  const body = await loadCodeBody(s.chatId);
  if (body && !s.dirty && s.phase === "idle" && s.steps.length === 0) {
    s.steps = body.steps;
    s.cwd = body.cwd;
    if (body.harnessId && HARNESS_BY_ID[body.harnessId]) s.harnessId = body.harnessId;
    if (body.model) s.model = body.model;
    // A saved pair can be inconsistent (e.g. a legacy body, or a save from before the guard) —
    // the harness CLI hard-errors on a foreign model id, so re-align here.
    if (!choiceFitsHarness(s.model, s.harnessId)) s.model = defaultModelForHarness(s.harnessId);
    s.permissionMode = body.permissionMode;
    s.resumeId = body.resumeId ?? null;
    if (typeof body.contextTokens === "number") s.contextTokens = body.contextTokens;
    if (typeof body.cost === "number") s.cost = body.cost;
    s.title = body.title;
  }
  s.loading = false;
  commit(s);
}

// True when this code chat has no steps yet (pristine "new session").
export function isEmptyCodeSession(chatId: string): boolean {
  const s = codeSessions.get(chatId);
  return s ? s.steps.length === 0 : !getCodeChats().some((c) => c.id === chatId);
}

export function dropCodeSession(chatId: string): void {
  const s = codeSessions.get(chatId);
  if (s?.saveTimer) clearTimeout(s.saveTimer);
  s?.abort?.abort();
  codeSessions.delete(chatId);
}

// ---- React binding ----

export function useCodeSession(chatId: string): CodeSessionView {
  const s = ensure(chatId);
  const subscribe = useCallback((cb: () => void) => {
    s.listeners.add(cb);
    return () => s.listeners.delete(cb);
  }, [s]);
  return useSyncExternalStore(subscribe, () => s.view);
}

// ---- Setters (per-chat config) ----

export function setCodeCwd(chatId: string, cwd: string): void {
  const s = ensure(chatId);
  if (s.cwd === cwd) return;
  s.cwd = cwd;
  s.dirty = true;
  commit(s);
}

export function setCodeHarness(chatId: string, harnessId: string): void {
  const s = ensure(chatId);
  const h = HARNESS_BY_ID[harnessId];
  if (!h || s.harnessId === harnessId) return;
  s.harnessId = harnessId;
  // A model pick only makes sense for the harness family it belongs to (codex ↔ claude-code).
  if (!choiceFitsHarness(s.model, harnessId)) s.model = defaultModelForHarness(harnessId);
  s.resumeId = null; // a session id belongs to the harness that minted it
  s.dirty = true;
  commit(s);
}

export function setCodeModel(chatId: string, choice: CodeModelChoice): void {
  const s = ensure(chatId);
  if (sameChoice(s.model, choice)) return;
  s.model = choice;
  s.dirty = true;
  commit(s);
}

export function setCodePermissionMode(chatId: string, permissionMode: string): void {
  const s = ensure(chatId);
  if (s.permissionMode === permissionMode) return;
  s.permissionMode = permissionMode;
  s.dirty = true;
  commit(s);
}

// ---- Run ----

// Resolve the endpoint the run should ultimately land on. Native kinds (anthropic/codex) →
// no target (each CLI's own login); everything else routes through the per-run local gateway:
// Ollama serves both protocols so the target matches the harness's own dialect (pure passthrough);
// a user gateway carries its declared protocol; connected providers are OpenAI-compatible.
// Throws a user-readable message on missing config/keys.
export interface SendTarget {
  protocol: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
}

async function resolveRouting(model: CodeModelChoice, harnessId: string): Promise<SendTarget | undefined> {
  if (model.kind === "anthropic" || model.kind === "codex") return undefined;
  if (!model.id) throw new Error("Pick a model for this environment first (add a gateway or connect a provider).");
  if (model.kind === "ollama") {
    const proto = HARNESS_BY_ID[harnessId]?.protocol ?? "anthropic";
    return { protocol: proto, baseUrl: proto === "openai" ? `${OLLAMA_HOST}/v1` : OLLAMA_HOST, apiKey: "ollama" };
  }
  if (model.kind === "gateway") {
    const g = getGateways().find((g) => g.id === model.gatewayId);
    if (!g) throw new Error(`Gateway for "${model.label}" is no longer configured — pick another model.`);
    const key = await secretGet(gatewaySecretKey(g.id)).catch(() => null);
    if (!key) throw new Error(`API key for gateway "${g.name}" is missing from the keychain — re-add the gateway.`);
    return { protocol: g.protocol ?? "anthropic", baseUrl: g.baseUrl, apiKey: key };
  }
  const base = model.providerId === "openai" ? "https://api.openai.com/v1" : KEY_PROVIDER_BASE[model.providerId];
  if (!base) throw new Error(`Unknown provider "${model.providerId}" — pick another model.`);
  const key = await getKey(model.providerId).catch(() => "");
  if (!key) throw new Error(`No API key saved for ${model.providerId} — connect it in Providers.`);
  return { protocol: "openai", baseUrl: base, apiKey: key };
}

// Drive one agent turn. Appends the user step, streams transcript steps, ends idle.
export async function sendCodeMessage(chatId: string, prompt: string): Promise<void> {
  const s = ensure(chatId);
  const text = prompt.trim();
  if (!text || s.phase === "running" || !s.cwd) return;

  s.steps = [...s.steps, { type: "user", text }];
  s.dirty = true;
  s.phase = "running";
  commit(s);

  // Last line of defense: never hand a foreign model id to the harness CLI (codex only serves
  // its own account's models; claude-code covers everything else via env routing / the bridge).
  if (!choiceFitsHarness(s.model, s.harnessId)) {
    const h = HARNESS_BY_ID[s.harnessId];
    s.steps = [
      ...s.steps,
      { type: "text", text: `⚠️ "${s.model.label}" can't run on the ${h?.name ?? s.harnessId} environment — pick a model from this environment's list.` },
    ];
    s.phase = "idle";
    commit(s);
    return;
  }

  let target: SendTarget | undefined;
  try {
    target = await resolveRouting(s.model, s.harnessId);
  } catch (e) {
    s.steps = [...s.steps, { type: "text", text: `⚠️ ${e instanceof Error ? e.message : String(e)}` }];
    s.phase = "idle";
    commit(s);
    return;
  }
  // Native runs prefer the account connected in Providers when available (codex → auth.json in an
  // isolated CODEX_HOME; claude → CLAUDE_CODE_OAUTH_TOKEN env); otherwise the CLI's own login.
  const codexAuth = s.model.kind === "codex" ? (await getCodexAuth().catch(() => null)) ?? undefined : undefined;
  const claudeToken =
    s.model.kind === "anthropic" ? (await getAnthropicAccessToken().catch(() => null)) ?? undefined : undefined;

  const controller = new AbortController();
  s.abort = controller;
  const runId = crypto.randomUUID();
  const permissionMode = s.permissionMode;
  const resume = s.resumeId ?? undefined;
  let sawError = false;
  let gotSession = false;
  try {
    for await (const delta of runAgentToSteps(
      { harness: s.harnessId, model: s.model.id, prompt: text, cwd: s.cwd, permissionMode, resume, target, codexAuth, claudeToken },
      runId,
      controller.signal
    )) {
      if (delta.op === "usage") {
        s.contextTokens = delta.contextTokens;
        s.cost = delta.cost;
      } else if (delta.op === "session") {
        s.resumeId = delta.id;
        gotSession = true;
      } else {
        if (delta.op === "error") sawError = true;
        s.steps = applyDelta(s.steps, delta);
      }
      commit(s);
    }
  } finally {
    // A failed run that never opened a session likely means the resume id went stale (CLI
    // session pruned, Codex auth-mode switch) — drop it so the next turn starts fresh.
    if (sawError && !gotSession) s.resumeId = null;
    if (s.abort === controller) s.abort = null;
    s.phase = "idle";
    commit(s); // now idle → schedulePersist flushes the finished transcript
  }
}

export function stopCode(chatId: string): void {
  codeSessions.get(chatId)?.abort?.abort();
}
