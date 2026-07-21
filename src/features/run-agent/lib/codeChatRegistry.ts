// codeChatRegistry.ts — module-level registry of AI SDK `Chat` instances, one per code chat, plus
// each chat's run config (harness / model / cwd / permission). The Chat holds streaming state
// outside React, so a generation survives a chat/screen switch (the Modelius invariant). A chat's
// transport (codeTransport.ts) calls back into `resolveSend` here to turn the message list + config
// into a concrete `agent_run` invocation. Persistence + the UI subscription layer wrap this.
import type { UIMessage } from "ai";
import { Chat } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { HARNESSES, HARNESS_BY_ID } from "@/entities/agent/model/harnesses";
import {
  DEFAULT_CODE_MODEL,
  choiceFitsHarness,
  defaultModelForHarness,
  type CodeModelChoice,
} from "@/entities/agent/model/codeModel";
import { CODEX_EFFORT_DEFAULT, type EffortLevel } from "@/entities/model/model/apiIds";
import { effortSurface, pickEffort } from "@/entities/session/api/effortSurface";
import { getGateways, gatewaySecretKey } from "@/entities/agent/model/gateways";
import { OLLAMA_HOST } from "@/entities/session/model/ollamaSession";
import { getCodexAuth } from "@/entities/session/model/openaiSession";
import { lastOfRole } from "@/shared/lib/lastOfRole";
import { getAnthropicAccessToken } from "@/entities/session/model/anthropicSession";
import { getKey } from "@/entities/session/model/keys";
import { KEY_PROVIDER_BASE } from "@/entities/session/model/keyProviders";
import { secretGet } from "@/shared/api/secrets";
import { getCodeChats, loadCodeBody, saveCodeBody, upsertCodeChat, codeIndexEntryFrom } from "@/entities/agent/model/codeChats";
import { invalidateCodeUsage } from "@/pages/code/model/codeUsage";
import { generateTitle } from "@/pages/chat/model/generateTitle";
import { pickSummarizerBackend } from "@/features/pick-backend/model/pickBackend";
import { route } from "@/features/route-request/model/route";
import { TITLE_PROMPT } from "@/shared/config/prompts";
import { CodeChatTransport, type ResolvedSend, type RunConfig } from "./codeTransport";

const DEFAULT_HARNESS = HARNESSES[0].id;

export interface CodeConfig {
  harness: string;
  model: CodeModelChoice;
  cwd: string;
  permissionMode: string;
  effort: EffortLevel | "auto"; // reasoning depth for Anthropic picks; "auto" → the tier default
}

interface Entry {
  chat: Chat<UIMessage>;
  config: CodeConfig;
  listeners: Set<() => void>;
  createdAt: number;
  title: string; // LLM-generated chat name (empty → sidebar falls back to the first-message snippet)
  titleTried: boolean; // guard: generate the title at most once per warm chat
}

// Dev-only HMR guard: a hot update would swap in a fresh empty map, orphaning live Chats mid-turn
// (reload-from-disk races the not-yet-flushed async persist and clobbers the latest turn). Stashing
// the map in import.meta.hot.data keeps in-flight chats intact; in prod hot is undefined → new Map.
const entries: Map<string, Entry> =
  (import.meta.hot?.data as { entries?: Map<string, Entry> } | undefined)?.entries ?? new Map<string, Entry>();
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data: { entries?: Map<string, Entry> }) => {
    data.entries = entries;
  });
}

function defaultConfig(): CodeConfig {
  return { harness: DEFAULT_HARNESS, model: DEFAULT_CODE_MODEL, cwd: "", permissionMode: "acceptEdits", effort: "auto" };
}

// Concatenate the text parts of a UIMessage (the CLI prompt is plain text).
function textOf(msg: UIMessage | undefined): string {
  if (!msg?.parts) return "";
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as any).text === "string")
    .map((p) => p.text)
    .join("\n");
}

// Image `file` parts of a UIMessage → {mime, base64} for the harness's native image block. The AI
// SDK stores an attached image as a `file` part whose `url` is a data URL; strip the prefix to the
// raw base64 the Rust side wraps. Non-image or non-data-URL parts are ignored.
function imagesOf(msg: UIMessage | undefined): { mime: string; data: string }[] {
  if (!msg?.parts) return [];
  const out: { mime: string; data: string }[] = [];
  for (const p of msg.parts as any[]) {
    if (p.type !== "file" || typeof p.url !== "string") continue;
    const mime: string = p.mediaType ?? "";
    if (!mime.startsWith("image/")) continue;
    const comma = p.url.indexOf(",");
    if (!p.url.startsWith("data:") || comma === -1) continue;
    out.push({ mime, data: p.url.slice(comma + 1) });
  }
  return out;
}

type SendTarget = RunConfig["target"];

// Resolve the endpoint a run should land on — mirrors the old codeSessionStore.resolveRouting.
// Native picks (anthropic/codex/kimi) → undefined (the CLI's own login); everything else routes
// through the per-run local gateway. Throws a user-readable message on missing config/keys.
async function resolveRouting(model: CodeModelChoice, harnessId: string): Promise<SendTarget> {
  if (model.kind === "anthropic" || model.kind === "codex" || model.kind === "kimi") return undefined;
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
  // Anthropic by key: the gateway translates the CLI's protocol onto /v1/messages.
  if (model.providerId === "anthropic") {
    const key = await getKey("anthropic").catch(() => "");
    if (!key) throw new Error("No API key saved for anthropic — connect it in Providers.");
    return { protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: key };
  }
  const base = model.providerId === "openai" ? "https://api.openai.com/v1" : KEY_PROVIDER_BASE[model.providerId];
  if (!base) throw new Error(`Unknown provider "${model.providerId}" — pick another model.`);
  const key = await getKey(model.providerId).catch(() => "");
  if (!key) throw new Error(`No API key saved for ${model.providerId} — connect it in Providers.`);
  return { protocol: "openai", baseUrl: base, apiKey: key };
}

// Which catalog answers for a pick. Native picks are their own kind; a routed pick is really the
// provider behind the local proxy, so it answers as that provider (an OpenRouter key or an
// OpenRouter-hosted gateway both map to "openrouter", whose reasoning the proxy translates).
function effortProvider(model: CodeConfig["model"]): string {
  if (model.kind === "connected") return model.providerId;
  if (model.kind === "gateway") {
    const g = getGateways().find((x) => x.id === model.gatewayId);
    return g && /openrouter\.ai/i.test(g.baseUrl) ? "openrouter" : "";
  }
  return model.kind;
}

// Effort surface for the CodeScreen picker: the pickable levels (null = no knob) and the level
// "auto" tracks. Per-provider resolution lives in effortSurface, shared with Chat mode.
export function codeEffortInfo(model: CodeConfig["model"]): { levels: EffortLevel[] | null; dflt: EffortLevel } {
  return effortSurface(effortProvider(model), model.id) ?? { levels: null, dflt: CODEX_EFFORT_DEFAULT };
}

// Concrete effort level for the CLI. An Anthropic-login pick resolves auto → the level the picker
// shows, since it promises a concrete one. Every other source passes an explicit pick through
// (codex rides turn/start, routed picks ride --effort into the proxy) and leaves "auto" as "" —
// the CLI's own default, exactly as if the user never touched the knob.
function resolvedEffort(config: CodeConfig): string {
  const surface = effortSurface(effortProvider(config.model), config.model.id);
  if (!surface) return "";
  if (config.model.kind === "anthropic") return pickEffort(surface, config.effort);
  return config.effort !== "auto" && surface.levels.includes(config.effort) ? config.effort : "";
}

// Turn the current message list + config into a concrete run (called by the transport per send).
async function resolveSend(chatId: string, messages: UIMessage[]): Promise<ResolvedSend> {
  const { config } = ensure(chatId);
  const lastUser = lastOfRole(messages, "user");
  const prompt = textOf(lastUser);
  const images = imagesOf(lastUser);
  // Last assistant turn that actually carries a resume id — a cancelled or errored turn's
  // message may have none; an earlier turn's id still resumes the same CLI session.
  const resume = (
    lastOfRole(messages, "assistant", (m) => !!(m.metadata as { sessionId?: string } | undefined)?.sessionId)
      ?.metadata as { sessionId?: string } | undefined
  )?.sessionId;

  // Never hand a foreign model id to the harness CLI (codex only serves its own models).
  if (!choiceFitsHarness(config.model, config.harness)) {
    const h = HARNESS_BY_ID[config.harness];
    throw new Error(`"${config.model.label}" can't run on the ${h?.name ?? config.harness} environment — pick a model from this environment's list.`);
  }

  const target = await resolveRouting(config.model, config.harness);
  const codexAuth = config.model.kind === "codex" ? (await getCodexAuth().catch(() => null)) ?? undefined : undefined;
  const claudeToken = config.model.kind === "anthropic" ? (await getAnthropicAccessToken().catch(() => null)) ?? undefined : undefined;

  return {
    prompt,
    images,
    resume,
    run: { harness: config.harness, model: config.model.id, cwd: config.cwd, permissionMode: config.permissionMode, effort: resolvedEffort(config), target, codexAuth, claudeToken },
  };
}

function ensure(chatId: string): Entry {
  let e = entries.get(chatId);
  if (e) return e;
  const chat = new Chat<UIMessage>({
    id: chatId,
    transport: new CodeChatTransport(chatId, (messages) => resolveSend(chatId, messages)),
    onFinish: () => {
      void persist(chatId); // save the finished transcript + index it for the sidebar
      maybeGenerateTitle(chatId); // name the chat from its first exchange (like Chat mode)
    },
  });
  e = { chat, config: defaultConfig(), listeners: new Set(), createdAt: Date.now(), title: "", titleTried: false };
  entries.set(chatId, e);
  void load(chatId);
  return e;
}

// Restore a saved chat's config + messages once (guarding against clobbering an in-flight run).
async function load(chatId: string): Promise<void> {
  const e = entries.get(chatId);
  if (!e) return;
  const existing = getCodeChats().find((c) => c.id === chatId);
  if (!existing) return; // fresh chat — nothing persisted
  e.createdAt = existing.createdAt;
  const body = await loadCodeBody(chatId);
  if (!body || e.chat.messages.length > 0 || e.chat.status !== "ready") return;
  let model = body.model ?? e.config.model;
  const harness = body.harnessId && HARNESS_BY_ID[body.harnessId] ? body.harnessId : e.config.harness;
  if (!choiceFitsHarness(model, harness)) model = defaultModelForHarness(harness);
  e.config = { harness, model, cwd: body.cwd, permissionMode: body.permissionMode, effort: (body.effort as EffortLevel | "auto") ?? "auto" };
  e.chat.messages = body.messages;
  if (body.title) {
    e.title = body.title;
    e.titleTried = true; // already named — don't regenerate
  }
  e.listeners.forEach((fn) => fn());
}

// Per-chat write queue: serialize persistence so overlapping writes can't race. `saveCodeBody`
// encrypts + writes SQLite asynchronously, so two fire-and-forget persists (e.g. a turn's onFinish
// racing a config change) could otherwise land out of order and clobber the newer transcript with
// an older one. Each persist chains after the prior; the last-enqueued state always wins.
const persistChain = new Map<string, Promise<void>>();

function persist(chatId: string): Promise<void> {
  const prev = persistChain.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => persistNow(chatId));
  persistChain.set(chatId, next);
  void next.finally(() => {
    if (persistChain.get(chatId) === next) persistChain.delete(chatId); // drop the settled tail
  });
  return next;
}

// Persist the transcript + config and index it for the sidebar. No-op until a user message exists.
// Reads the live state at run time, so a queued write always flushes the latest transcript.
async function persistNow(chatId: string): Promise<void> {
  const e = entries.get(chatId);
  if (!e) return;
  const messages = e.chat.messages;
  const entry = codeIndexEntryFrom(chatId, messages, e.createdAt, e.title, e.config.cwd);
  if (!entry) return;
  await saveCodeBody(chatId, {
    messages,
    cwd: e.config.cwd,
    harnessId: e.config.harness,
    modelId: e.config.model.id,
    model: e.config.model,
    permissionMode: e.config.permissionMode,
    effort: e.config.effort,
    title: e.title,
  });
  upsertCodeChat(entry);
  invalidateCodeUsage();
}

// Name a code chat from its first exchange via a cheap backend, once per chat (mirrors Chat mode's
// maybeGenerateTitle). Best-effort: no backend / offline → "" → sidebar keeps the snippet fallback.
function maybeGenerateTitle(chatId: string): void {
  const e = entries.get(chatId);
  if (!e || e.titleTried || e.title) return;
  const firstUser = e.chat.messages.find((m) => m.role === "user");
  const firstAsst = e.chat.messages.find((m) => m.role === "assistant" && textOf(m).trim());
  if (!firstUser || !firstAsst) return;
  e.titleTried = true;
  generateTitle(textOf(firstUser), textOf(firstAsst), pickSummarizerBackend(route(TITLE_PROMPT, "cost"))).then((t) => {
    if (!t) return;
    e.title = t;
    e.listeners.forEach((fn) => fn());
    void persist(chatId); // re-index so the sidebar shows the generated name
  });
}

export function getCodeChat(chatId: string): Chat<UIMessage> {
  return ensure(chatId).chat;
}

export function getCodeConfig(chatId: string): CodeConfig {
  return ensure(chatId).config;
}

// The generated chat name ("" until named). Reactive via subscribeCodeConfig — maybeGenerateTitle
// notifies the same listener set, so a snapshot on this string re-renders when the title lands.
export function getCodeTitle(chatId: string): string {
  return ensure(chatId).title;
}

// Patch a chat's config (re-aligns the model when the harness family changes) and notify subscribers.
export function setCodeConfig(chatId: string, patch: Partial<CodeConfig>): void {
  const e = ensure(chatId);
  e.config = { ...e.config, ...patch };
  if (patch.harness && !choiceFitsHarness(e.config.model, e.config.harness)) {
    e.config.model = defaultModelForHarness(e.config.harness);
  }
  e.listeners.forEach((fn) => fn());
  void persist(chatId); // durable config (no-op until the chat has a user message)
}

export function subscribeCodeConfig(chatId: string, cb: () => void): () => void {
  const e = ensure(chatId);
  e.listeners.add(cb);
  return () => e.listeners.delete(cb);
}

// True when this code chat has no transcript yet (pristine "new session").
export function isEmptyCodeChat(chatId: string): boolean {
  const e = entries.get(chatId);
  if (e) return e.chat.messages.length === 0;
  return !getCodeChats().some((c) => c.id === chatId);
}

export function dropCodeChat(chatId: string): void {
  const e = entries.get(chatId);
  void e?.chat.stop();
  entries.delete(chatId);
  // Reap the chat's warm CLI process (no-op when none is live).
  void invoke("agent_session_close", { sessionKey: chatId }).catch(() => {});
}
