// sessionStore.ts — global per-chat session state + streaming orchestration.
// Streaming runs at module scope, not in ChatScreen, so a generation survives a chat/screen
// switch. ChatScreen subscribes and renders. In the page: drives streamLLM.
import { useCallback, useSyncExternalStore } from "react";
import { route, classify } from "@/features/route-request/model/route";
import { classifyRequest } from "@/features/route-request/model/classifyRequest";
import { SYSTEM_PROMPT, SUMMARY_PROMPT, MEMORY_EXTRACT_PROMPT, TITLE_PROMPT } from "@/shared/config/prompts";
import { estimateTokens, ctxTokens } from "@/shared/lib/tokens";
import { costOf, priceSource as priceSource_ } from "@/entities/model/lib/pricing";
import type { Message, Decision, PolicyId, ImageRef } from "@/entities/model/model/registry";
import type { ChatMsg, Delta, Backend, ModelOption } from "@/entities/model/model/backend";
import { CODEX_MODELS, ctxForBackend, effortForDifficulty, type EffortLevel } from "@/entities/model/model/apiIds";
import { pickBackend, pickSummarizerBackend, liveRoutingPool } from "@/features/pick-backend/model/pickBackend";
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import { memoryBlock, getMemories, applyMemoryOps, hydrateMemory } from "@/entities/memory/model/memory";
import { extractMemories } from "@/pages/chat/model/extractMemories";
import { generateTitle } from "@/pages/chat/model/generateTitle";
import { humanizeError } from "@/shared/lib/errors";
import {
  extractAndSave,
  redactCode,
  referencedIds,
  loadArtifact,
  artifactLang,
  largeBlockIds,
  wrapFence,
} from "@/entities/artifact/model/artifacts";
import { getChats, loadChatBody, saveChatBody, upsertChat, indexEntryFrom } from "@/entities/chat/model/chats";

type Phase = "idle" | "routing" | "streaming";

const MEMORY_EVERY = 3; // extract memory on every Nth finished turn (1st, 4th, …)

// Immutable view the component subscribes to (re-created per commit).
export interface SessionView {
  messages: Message[];
  phase: Phase;
  compacting: boolean;
  title: string;
  titleSettled: boolean;
  loading: boolean; // saved body still being fetched — suppress the new-chat hero
}

// Params the composer hands to the store, which does routing/streaming.
export interface SendParams {
  policy: PolicyId;
  modelSel: ModelOption | null; // null = Auto (routed)
  thinking: boolean;
  effort: EffortLevel | "auto";
  fullText: string;
  images: ImageRef[];
}

interface Session {
  chatId: string;
  messages: Message[];
  summary: string; // compressed brief of old turns
  covered: number; // leading messages folded into `summary`
  phase: Phase;
  compacting: boolean;
  title: string;
  titleSettled: boolean;
  loading: boolean;
  createdAt: number;
  dirty: boolean; // set on first user action; gates persistence (skip the demo)
  memoryTurns: number; // finished assistant turns, for throttling memory extraction
  titleTried: boolean;
  saveTimer: number | null;
  abort: AbortController | null; // active stream's canceller; set while streaming, else null
  listeners: Set<() => void>;
  view: SessionView;
}

const sessions = new Map<string, Session>();

function rebuildView(s: Session): void {
  s.view = {
    messages: s.messages,
    phase: s.phase,
    compacting: s.compacting,
    title: s.title,
    titleSettled: s.titleSettled,
    loading: s.loading,
  };
}

// Re-snapshot, notify subscribers, debounced-persist once idle.
function commit(s: Session): void {
  rebuildView(s);
  s.listeners.forEach((fn) => fn());
  schedulePersist(s);
}

function schedulePersist(s: Session): void {
  if (!s.dirty || s.phase !== "idle") return; // don't persist mid-stream/seed-only
  if (s.saveTimer) clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => {
    s.saveTimer = null;
    const entry = indexEntryFrom(s.chatId, s.messages, s.createdAt, s.title, s.titleSettled);
    if (!entry) return;
    void saveChatBody(s.chatId, { messages: s.messages, summary: s.summary, covered: s.covered, title: s.title });
    upsertChat(entry);
  }, 400) as unknown as number;
}

function ensure(chatId: string, demo: boolean): Session {
  let s = sessions.get(chatId);
  if (s) return s;
  // Known chat (in the index) has a saved body loading async — flag it so the view
  // doesn't flash the new-chat hero before the body arrives.
  const known = !demo && getChats().some((c) => c.id === chatId);
  s = {
    chatId,
    messages: [],
    summary: "",
    covered: 0,
    phase: "idle",
    compacting: false,
    title: "",
    titleSettled: false,
    loading: known,
    createdAt: Date.now(),
    dirty: false,
    memoryTurns: 0,
    titleTried: false,
    saveTimer: null,
    abort: null,
    listeners: new Set(),
    view: null as unknown as SessionView,
  };
  rebuildView(s);
  sessions.set(chatId, s);
  void load(s, demo);
  return s;
}

// Load the saved body once, guarding against clobbering an in-flight stream (load may resolve late).
async function load(s: Session, demo: boolean): Promise<void> {
  const existing = getChats().find((c) => c.id === s.chatId);
  if (existing) s.createdAt = existing.createdAt; // keep original creation time
  if (!demo) {
    const body = await loadChatBody(s.chatId);
    if (body && !s.dirty && s.phase === "idle" && s.messages.length === 0) {
      s.messages = body.messages;
      s.summary = body.summary;
      s.covered = body.covered;
      s.title = body.title;
    }
  }
  s.loading = false;
  commit(s);
  maybeGenerateTitle(s); // backfill title for an older untitled chat
}

// True when this chat has no messages yet (a pristine "new chat"). Lets "New chat" reuse the
// current id — preserving its unsent draft — instead of spinning a fresh, unreachable one.
export function isEmptySession(chatId: string): boolean {
  const s = sessions.get(chatId);
  return s ? s.messages.length === 0 : !getChats().some((c) => c.id === chatId);
}

// Drop a session (on chat delete) so a stray commit can't resurrect it.
export function dropSession(chatId: string): void {
  const s = sessions.get(chatId);
  if (s?.saveTimer) clearTimeout(s.saveTimer);
  sessions.delete(chatId);
}

// ---- React binding ----

export function useSession(chatId: string, demo: boolean): SessionView {
  const s = ensure(chatId, demo);
  const subscribe = useCallback((cb: () => void) => {
    s.listeners.add(cb);
    return () => s.listeners.delete(cb);
  }, [s]);
  return useSyncExternalStore(subscribe, () => s.view);
}

// ---- Mutators ----

function append(s: Session, msg: Message): void {
  s.messages = [...s.messages, msg];
  commit(s);
}

function patchLastStreaming(s: Session, patch: Partial<Message>): void {
  const i = s.messages.length - 1;
  const last = s.messages[i];
  if (!last || !last.streaming) return;
  s.messages = s.messages.slice();
  s.messages[i] = { ...last, ...patch };
  commit(s);
}

function patchAt(s: Session, i: number, patch: Partial<Message>): void {
  if (!s.messages[i]) return;
  s.messages = s.messages.slice();
  s.messages[i] = { ...s.messages[i], ...patch };
  commit(s);
}

function setPhase(s: Session, phase: Phase): void {
  s.phase = phase;
  commit(s);
}

// ---- Orchestration ----

// Name the model that actually answered, not the routed pick (pickBackend may run an
// OpenAI route on a ChatGPT account or fall back). Override only when they diverge.
function backendBadge(backend: Backend, decision: Decision): { label: string; provider: string } | undefined {
  const provider =
    backend.kind === "anthropic" ? "anthropic" : backend.kind === "compat" ? backend.providerId ?? "" : "openai";
  if (provider === decision.chosen.provider && backend.kind !== "chatgpt") return undefined;
  const codex = CODEX_MODELS.find((m) => m.id === backend.model);
  return { label: codex?.name ?? backend.label ?? backend.model, provider };
}

// Compress stale turns via the cheapest backend, keeping a long chat inside the window
// even after switching to a small-ctx model. "" → just send recent.
async function summarize(prior: string, stale: Message[]): Promise<string> {
  const sb = pickSummarizerBackend(route(SUMMARY_PROMPT, "cost"));
  if (sb.kind === "none") return "";
  const transcript = stale.map((m) => `${m.role}: ${redactCode(m.text).text}`).join("\n");
  const prompt = SUMMARY_PROMPT + (prior ? `Previous summary:\n${prior}\n\n` : "") + transcript;
  let out = "";
  try {
    for await (const d of streamLLM(sb, [{ role: "user", content: prompt }])) {
      if (d.kind === "text") out += d.text;
    }
  } catch {
    return "";
  }
  return out.trim();
}

// Summarize off the critical path: this turn sends current history; result is ready for the next.
function compactInBackground(s: Session, hist: Message[], cov: number, prior: string, keep: number): void {
  s.compacting = true;
  commit(s);
  summarize(prior, hist.slice(cov, hist.length - keep))
    .then((fresh) => {
      if (fresh) {
        s.summary = fresh;
        s.covered = hist.length - keep;
      }
    })
    .finally(() => {
      s.compacting = false;
      commit(s);
    });
}

// Generate the chat title from its first exchange, once per chat.
function maybeGenerateTitle(s: Session): void {
  if (s.titleTried || s.title) return;
  const firstUser = s.messages.find((m) => m.role === "user");
  const firstAsst = s.messages.find((m) => m.role === "assistant" && !m.streaming && m.text.trim());
  if (!firstUser || !firstAsst) return;
  s.titleTried = true;
  generateTitle(firstUser.text, firstAsst.text, pickSummarizerBackend(route(TITLE_PROMPT, "cost"))).then((t) => {
    if (t) s.title = t;
    s.titleSettled = true; // settled (even if empty) → callers may use first-msg fallback
    commit(s);
  });
}

// Route a turn and kick off streaming. `history` is the thread state the API sees (excludes the
// current user turn). `appendUser` is false on regenerate, where the user turn already exists.
async function dispatch(s: Session, p: SendParams, history: Message[], appendUser: boolean): Promise<void> {
  const { policy, modelSel, thinking, effort, fullText, images: imgs } = p;

  // An attached image forces a vision-capable model regardless of policy. Context pressure
  // (history + summary + this turn) floors the pool to models whose window can hold it.
  const ctxUsed =
    history.reduce((n, m) => n + estimateTokens(m.text), estimateTokens(s.summary)) + estimateTokens(fullText);
  const pool = liveRoutingPool();
  const routeOpts = { requireVision: imgs.length > 0, contextTokens: ctxUsed, pool };

  // Heuristic first: drives the none-check, the manual override, and the confident fast-path
  // (no LLM call). The phase guard below blocks re-entry, so the async refine has no race.
  const heur = classify(fullText);
  let decision = route(fullText, policy, { ...routeOpts, classification: heur });
  let backend = modelSel ? modelSel.backend : pickBackend(decision);
  // Nothing connected — bail before touching the thread; the composer prompts to connect a model.
  if (backend.kind === "none") return;

  s.dirty = true; // user acted → now worth persisting
  if (appendUser) {
    append(s, { role: "user", text: fullText, images: imgs.length ? imgs : undefined });
    void extractAndSave(fullText); // persist large code blocks as artifacts
  }
  setPhase(s, "routing");

  // Hybrid: for an ambiguous auto-route, refine difficulty with the cheap LLM classifier,
  // then re-route. Manual picks and confident heuristics skip this entirely.
  if (!modelSel && !heur.confident) {
    const cls = await classifyRequest(fullText, { pool });
    decision = route(fullText, policy, { ...routeOpts, classification: cls });
    const b = pickBackend(decision);
    if (b.kind !== "none") backend = b;
  }

  // Name the model that actually answered (pickBackend may diverge from the routed pick).
  const manual = modelSel ? { label: modelSel.label, provider: modelSel.provider } : backendBadge(backend, decision);
  // "auto" effort tracks the routed difficulty; explicit levels pass through.
  const eff = effort === "auto" ? effortForDifficulty(decision.classification.difficulty ?? 0) : effort;
  void realSend(s, decision, history, backend, manual, thinking, eff, fullText, imgs, !!modelSel);
}

export function sendMessage(chatId: string, p: SendParams): void {
  const s = sessions.get(chatId);
  if (!s || s.phase !== "idle") return;
  void dispatch(s, p, s.messages, true); // snapshot history before the new user turn is appended
}

// Re-run the last assistant turn: drop it, re-route the prompting user message, stream a fresh
// answer. Params (policy/model/thinking/effort) come from the composer's current selection.
export function regenerate(chatId: string, p: Omit<SendParams, "fullText" | "images">): void {
  const s = sessions.get(chatId);
  if (!s || s.phase !== "idle") return;
  const lastIdx = s.messages.length - 1;
  if (lastIdx < 0 || s.messages[lastIdx].role !== "assistant") return;
  let userIdx = lastIdx - 1;
  while (userIdx >= 0 && s.messages[userIdx].role !== "user") userIdx--;
  if (userIdx < 0) return;
  const userMsg = s.messages[userIdx];
  const history = s.messages.slice(0, userIdx); // everything before that user turn
  s.messages = s.messages.slice(0, lastIdx); // drop the trailing assistant; keep the user turn
  commit(s);
  void dispatch(s, { ...p, fullText: userMsg.text, images: userMsg.images ?? [] }, history, false);
}

// Edit a user message and resend: drop that turn and everything after it, then re-route the
// new text (keeping the original attachments) and stream a fresh answer.
export function editAndResend(chatId: string, msgIndex: number, newText: string, p: Omit<SendParams, "fullText" | "images">): void {
  const s = sessions.get(chatId);
  if (!s || s.phase !== "idle") return;
  const msg = s.messages[msgIndex];
  if (!msg || msg.role !== "user") return;
  const text = newText.trim();
  if (!text) return;
  const history = s.messages.slice(0, msgIndex); // everything before the edited turn
  const imgs = msg.images ?? []; // keep the original attachments
  s.messages = history; // drop the edited turn + everything after; dispatch re-appends the user turn
  s.covered = Math.min(s.covered, history.length); // summary can't cover dropped messages
  commit(s);
  void dispatch(s, { ...p, fullText: text, images: imgs }, history, true);
}

// Abort the active stream for this chat. Partial output already streamed is finalized in realSend.
export function stopStream(chatId: string): void {
  sessions.get(chatId)?.abort?.abort();
}

// Build the windowed request and stream a real completion. Stays in "routing" until
// the first token, then streams into the assistant message.
async function realSend(
  s: Session,
  decision: Decision,
  history: Message[],
  backend: Backend,
  manual: { label: string; provider: string } | undefined,
  reasoningOn: boolean,
  effortLevel: EffortLevel | "auto",
  fullText: string,
  imgs: ImageRef[],
  isManual: boolean
): Promise<void> {
  await hydrateMemory(); // ensure the decrypted memory cache is ready before building the prompt
  // Keep inside the window, budgeting by the routed pick's ctx (a stable proxy).
  // Soft (50%) → compact in background for next turn; hard (85%) → compact synchronously now.
  let sumText = s.summary;
  let cov = s.covered;
  const KEEP = 6; // last messages always sent verbatim
  // On a manual switch the active model's window can differ from the routed pick.
  const win = ctxTokens(isManual ? ctxForBackend(backend) : decision.chosen.ctx);
  const used = history.reduce((n, m) => n + estimateTokens(m.text), estimateTokens(sumText));
  const canCompact = history.length - KEEP > cov;
  if (used > win * 0.85 && canCompact) {
    const fresh = await summarize(sumText, history.slice(cov, history.length - KEEP));
    if (fresh) {
      sumText = fresh;
      cov = history.length - KEEP;
      s.summary = fresh;
      s.covered = cov;
      commit(s);
    }
  } else if (used > win * 0.5 && canCompact && !s.compacting) {
    compactInBackground(s, history, cov, sumText, KEEP);
  }

  // Re-inject verbatim only artifacts the summary references and not already in the recent
  // window. Bounded by a token cap; dropped (oldest-first) ids logged.
  const recent: ChatMsg[] = history
    .slice(cov)
    .map((m) => ({ role: m.role, content: m.text, images: m.images?.map((im) => ({ mime: im.mime, data: im.data })) }));
  const inRecent = new Set(recent.flatMap((m) => largeBlockIds(m.content)));
  const wanted = [...new Set(referencedIds(sumText))].filter((id) => !inRecent.has(id));
  let codeBudget = win * 0.3;
  const blocks: string[] = [];
  for (const id of wanted) {
    const code = await loadArtifact(id);
    if (code == null) continue; // invented/garbled id — skip
    const block = `[[${id}]]\n${wrapFence(artifactLang(id), code)}`;
    const t = estimateTokens(block);
    if (t > codeBudget) {
      console.warn(`[artifacts] dropping ${id} from context (appendix budget exceeded)`);
      continue;
    }
    codeBudget -= t;
    blocks.push(block);
  }
  const codeAppendix = blocks.length
    ? `\n\nReferenced code artifacts (verbatim, do not summarize):\n${blocks.join("\n\n")}`
    : "";

  // Long-term memory first, then the per-chat summary.
  const mem = memoryBlock();
  const sysContent =
    SYSTEM_PROMPT +
    (mem ? `\n\nWhat you remember about the user:\n${mem}` : "") +
    (sumText ? `\n\nSummary of earlier conversation:\n${sumText}` : "") +
    codeAppendix;
  const userMsg: ChatMsg = {
    role: "user",
    content: fullText,
    images: imgs.length ? imgs.map((im) => ({ mime: im.mime, data: im.data })) : undefined,
  };
  const apiMessages: ChatMsg[] = [{ role: "system", content: sysContent }, ...recent, userMsg];

  const controller = new AbortController();
  s.abort = controller;

  let acc = "";
  let reason = "";
  let usage: Extract<Delta, { kind: "usage" }> | undefined;
  const t0 = performance.now();
  let started = false;
  const begin = () => {
    started = true;
    setPhase(s, "streaming");
    append(s, {
      role: "assistant",
      text: "",
      decision,
      shown: "",
      streaming: true,
      modelLabel: manual?.label,
      modelProvider: manual?.provider,
    });
  };
  const update = () => patchLastStreaming(s, { shown: acc, reasoning: reason || undefined });

  try {
    for await (const delta of streamLLM(backend, apiMessages, reasoningOn, effortLevel, controller.signal)) {
      if (!started) begin();
      if (delta.kind === "usage") usage = delta;
      else if (delta.kind === "thinking") reason += delta.text;
      else acc += delta.text;
      update();
    }
    // User stopped: keep whatever streamed, skip usage/cost/memory for this partial turn.
    if (controller.signal.aborted) {
      if (started) patchLastStreaming(s, { text: acc, shown: acc, reasoning: reason || undefined, streaming: false });
      return;
    }
    if (!started) begin(); // empty completion — still show a turn
    const latencyMs = performance.now() - t0;
    const u = usage
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, reasoningTokens: usage.reasoningTokens }
      : { inputTokens: estimateTokens(apiMessages.map((mm) => mm.content).join("\n")), outputTokens: estimateTokens(acc) };
    // $ only for metered turns. Prefer the exact cost the API billed (OpenRouter); otherwise
    // compute it from token usage × current per-token rates.
    const exact = usage?.cost;
    const cost = usage?.metered
      ? exact != null && Number.isFinite(exact)
        ? exact
        : costOf(backend.model, u)
      : undefined;
    const priceSource = cost != null ? (exact != null ? "live" : priceSource_(backend.model) ?? undefined) : undefined;
    const asstIndex = s.messages.length - 1; // this turn's assistant message; stable (append-only)
    patchAt(s, asstIndex, { text: acc, shown: acc, reasoning: reason || undefined, streaming: false, usage: u, latencyMs, cost, priceSource });
    if (acc.trim()) void extractAndSave(acc); // persist large code the model returned
    // Reconcile durable user facts off the critical path, throttled to every MEMORY_EVERY-th
    // turn (1st, 4th, …) to cut cost/noise. Ops add/update/delete against known facts; tag the
    // message with what actually changed.
    if (acc.trim() && ++s.memoryTurns % MEMORY_EVERY === 1) {
      void extractMemories(fullText, acc, getMemories(), pickSummarizerBackend(route(MEMORY_EXTRACT_PROMPT, "cost")))
        .then((ops) => {
          const changed = applyMemoryOps(ops);
          if (changed.length) patchAt(s, asstIndex, { memory: changed });
        })
        .catch(() => {});
    }
  } catch (err) {
    // Abort surfaces as a fetch error on the browser paths — finalize the partial, not an error.
    if (controller.signal.aborted) {
      if (started) patchLastStreaming(s, { text: acc, shown: acc, reasoning: reason || undefined, streaming: false });
    } else {
      const msg = `⚠️ ${humanizeError(err instanceof Error ? err.message : "Request failed")}`;
      if (!started) begin();
      patchAt(s, s.messages.length - 1, { text: msg, shown: msg, streaming: false });
    }
  } finally {
    if (s.abort === controller) s.abort = null;
    setPhase(s, "idle");
    maybeGenerateTitle(s);
  }
}
