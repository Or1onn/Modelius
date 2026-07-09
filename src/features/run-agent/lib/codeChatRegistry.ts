// codeChatRegistry.ts — module-level registry of AI SDK `Chat` instances, one per code chat, plus
// each chat's run config (harness / model / cwd / permission). The Chat holds streaming state
// outside React, so a generation survives a chat/screen switch (the Modelius invariant). A chat's
// transport (codeTransport.ts) calls back into `resolveSend` here to turn the message list + config
// into a concrete `agent_run` invocation. Persistence + the UI subscription layer wrap this.
import type { UIMessage } from "ai";
import { Chat } from "@ai-sdk/react";
import { HARNESSES, HARNESS_BY_ID } from "@/entities/agent/model/harnesses";
import {
  DEFAULT_CODE_MODEL,
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
import { getCodeChats, loadCodeBody, saveCodeBody, upsertCodeChat, codeIndexEntryFrom } from "@/entities/agent/model/codeChats";
import { invalidateCodeUsage } from "@/pages/code/model/codeUsage";
import { CodeChatTransport, type ResolvedSend, type RunConfig } from "./codeTransport";

const DEFAULT_HARNESS = HARNESSES[0].id;

export interface CodeConfig {
  harness: string;
  model: CodeModelChoice;
  cwd: string;
  permissionMode: string;
}

interface Entry {
  chat: Chat<UIMessage>;
  config: CodeConfig;
  listeners: Set<() => void>;
  createdAt: number;
}

// Preserve the registry across Vite HMR. Without this, a hot update replaces this module with a
// fresh (empty) `entries` map, orphaning live Chat instances mid-turn. On the next render `ensure`
// recreates each chat empty and `load` repopulates it from disk — but the async `persist` of the
// latest turn may not have flushed yet, so the live transcript gets clobbered back to the previous
// turn. Reusing the same map across HMR keeps the in-memory Chats (and in-flight turns) intact.
// Dev-only; `import.meta.hot` is undefined in a production build, so this is a plain new Map there.
const entries: Map<string, Entry> =
  (import.meta.hot?.data as { entries?: Map<string, Entry> } | undefined)?.entries ?? new Map<string, Entry>();
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data: { entries?: Map<string, Entry> }) => {
    data.entries = entries;
  });
}

function defaultConfig(): CodeConfig {
  return { harness: DEFAULT_HARNESS, model: DEFAULT_CODE_MODEL, cwd: "", permissionMode: "acceptEdits" };
}

// Concatenate the text parts of a UIMessage (the CLI prompt is plain text).
function textOf(msg: UIMessage | undefined): string {
  if (!msg?.parts) return "";
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as any).text === "string")
    .map((p) => p.text)
    .join("\n");
}

type SendTarget = RunConfig["target"];

// Resolve the endpoint a run should land on — mirrors the old codeSessionStore.resolveRouting.
// Native picks (anthropic/codex) → undefined (the CLI's own login); everything else routes through
// the per-run local gateway. Throws a user-readable message on missing config/keys.
async function resolveRouting(model: CodeModelChoice, harnessId: string): Promise<SendTarget> {
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

// Turn the current message list + config into a concrete run (called by the transport per send).
async function resolveSend(chatId: string, messages: UIMessage[]): Promise<ResolvedSend> {
  const { config } = ensure(chatId);
  const prompt = textOf([...messages].reverse().find((m) => m.role === "user"));
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const resume = (lastAssistant?.metadata as { sessionId?: string } | undefined)?.sessionId;

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
    resume,
    run: { harness: config.harness, model: config.model.id, cwd: config.cwd, permissionMode: config.permissionMode, target, codexAuth, claudeToken },
  };
}

function ensure(chatId: string): Entry {
  let e = entries.get(chatId);
  if (e) return e;
  const chat = new Chat<UIMessage>({
    id: chatId,
    transport: new CodeChatTransport((messages) => resolveSend(chatId, messages)),
    onFinish: () => void persist(chatId), // save the finished transcript + index it for the sidebar
  });
  e = { chat, config: defaultConfig(), listeners: new Set(), createdAt: Date.now() };
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
  e.config = { harness, model, cwd: body.cwd, permissionMode: body.permissionMode };
  e.chat.messages = body.messages;
  e.listeners.forEach((fn) => fn());
}

// Persist the transcript + config and index it for the sidebar. No-op until a user message exists.
async function persist(chatId: string): Promise<void> {
  const e = entries.get(chatId);
  if (!e) return;
  const messages = e.chat.messages;
  const entry = codeIndexEntryFrom(chatId, messages, e.createdAt, undefined, e.config.cwd);
  if (!entry) return;
  await saveCodeBody(chatId, {
    messages,
    cwd: e.config.cwd,
    harnessId: e.config.harness,
    modelId: e.config.model.id,
    model: e.config.model,
    permissionMode: e.config.permissionMode,
    title: "",
  });
  upsertCodeChat(entry);
  invalidateCodeUsage();
}

export function getCodeChat(chatId: string): Chat<UIMessage> {
  return ensure(chatId).chat;
}

export function getCodeConfig(chatId: string): CodeConfig {
  return ensure(chatId).config;
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
}
