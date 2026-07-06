// codeSessionStore.ts — global per-code-chat session state + agent-run orchestration.
// Mirrors pages/chat/model/sessionStore.ts, stripped to Code mode: the run streams transcript
// Steps (not text Deltas) via runAgentToSteps. Streaming runs at module scope so a run survives a
// chat/screen switch; CodeScreen subscribes via useCodeSession and renders.
import { useCallback, useSyncExternalStore } from "react";
import { HARNESSES, HARNESS_BY_ID } from "@/entities/agent/model/harnesses";
import { runAgentToSteps, applyDelta, type Step } from "@/features/run-agent/lib/agentChannel";
import { getCodeChats, loadCodeBody, saveCodeBody, upsertCodeChat, codeIndexEntryFrom } from "@/entities/agent/model/codeChats";

type Phase = "idle" | "running";

// Default harness + its first model (used for a fresh session, before any saved body loads).
const DEFAULT_HARNESS = HARNESSES[0].id;
const firstModelOf = (harnessId: string): string => HARNESS_BY_ID[harnessId]?.models()[0]?.id ?? "";

// Immutable view the component subscribes to (re-created per commit).
export interface CodeSessionView {
  steps: Step[];
  phase: Phase;
  cwd: string;
  harnessId: string;
  modelId: string;
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
  modelId: string;
  permissionMode: string;
  contextTokens: number;
  cost: number | null;
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
    modelId: s.modelId,
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
    const entry = codeIndexEntryFrom(s.chatId, s.steps, s.createdAt, s.title);
    if (!entry) return; // no user turn yet — nothing to index
    void saveCodeBody(s.chatId, {
      steps: s.steps,
      cwd: s.cwd,
      harnessId: s.harnessId,
      modelId: s.modelId,
      permissionMode: s.permissionMode,
      title: s.title,
    });
    upsertCodeChat(entry);
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
    modelId: firstModelOf(DEFAULT_HARNESS),
    permissionMode: "acceptEdits",
    contextTokens: 0,
    cost: null,
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
    if (body.modelId) s.modelId = body.modelId;
    s.permissionMode = body.permissionMode;
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
  // Keep the model valid for the new harness's model set.
  if (!h.models().some((m) => m.id === s.modelId)) s.modelId = firstModelOf(harnessId);
  s.dirty = true;
  commit(s);
}

export function setCodeModel(chatId: string, modelId: string): void {
  const s = ensure(chatId);
  if (s.modelId === modelId) return;
  s.modelId = modelId;
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

// Drive one agent turn. Appends the user step, streams transcript steps, ends idle.
export async function sendCodeMessage(chatId: string, prompt: string): Promise<void> {
  const s = ensure(chatId);
  const text = prompt.trim();
  if (!text || s.phase === "running" || !s.cwd) return;

  s.steps = [...s.steps, { type: "user", text }];
  s.dirty = true;
  s.phase = "running";
  commit(s);

  const controller = new AbortController();
  s.abort = controller;
  const runId = crypto.randomUUID();
  const permissionMode = s.permissionMode;
  try {
    for await (const delta of runAgentToSteps(
      { harness: s.harnessId, model: s.modelId, prompt: text, cwd: s.cwd, permissionMode },
      runId,
      controller.signal
    )) {
      if (delta.op === "usage") {
        s.contextTokens = delta.contextTokens;
        s.cost = delta.cost;
      } else {
        s.steps = applyDelta(s.steps, delta);
      }
      commit(s);
    }
  } finally {
    if (s.abort === controller) s.abort = null;
    s.phase = "idle";
    commit(s); // now idle → schedulePersist flushes the finished transcript
  }
}

export function stopCode(chatId: string): void {
  codeSessions.get(chatId)?.abort?.abort();
}
