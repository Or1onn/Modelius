// codeChats.ts — persisted Code-mode chat history, parallel to entities/chat/model/chats.ts.
// Separate namespace (own index key/event, own body prefix) so it never touches Chat persistence,
// but shares the `chats` SQLite table (UUID keys, opaque encrypted `data` — no row collision).
// The store mechanics live in chats.ts's factories; this module is configuration + body shape.
import { makeChatIndexStore, makeBodyStore, type ChatIndexEntry } from "@/entities/chat/model/chats";
import type { UIMessage } from "ai";
import { fromLegacyModelId, type CodeModelChoice } from "@/entities/agent/model/codeModel";

// ---- Index (encrypted localStorage blob + in-RAM cache, reactive) ----

const INDEX_KEY = "modelius.code.index";
const EVT = "modelius-code-changed";

// Reuse ChatIndexEntry — same shape the sidebar (ChatGroup/ChatRow) already renders.
export type { ChatIndexEntry };

const store = makeChatIndexStore(INDEX_KEY, EVT, (id) => deleteCodeBody(id));

export const hydrateCodeIndex = store.hydrate;
export const getCodeChats = store.getAll;
export const upsertCodeChat = store.upsert;
export const deleteCodeChat = store.del;
export const pinCodeChat = store.pin;
export const renameCodeChat = store.rename;

export function useCodeChatStore() {
  store.useSubscribe();
  return { getCodeChats, upsertCodeChat, deleteCodeChat, pinCodeChat, renameCodeChat };
}

// ---- Body (SQLite under Tauri / localStorage fallback) ----

// Body shape (AI SDK model). `messages` is the whole transcript; resume id + context/cost live in
// the last assistant message's metadata, so they're not stored separately.
export interface CodeChatBody {
  messages: UIMessage[];
  cwd: string;
  harnessId: string;
  modelId: string; // kept alongside `model` so pre-routing builds can still open the chat
  model?: CodeModelChoice;
  permissionMode: string;
  effort?: string; // "auto" or an Anthropic effort level; absent on pre-effort bodies
  title: string;
}

const BODY_PREFIX = "modelius.code.";
const bodyStore = makeBodyStore(BODY_PREFIX);

export async function saveCodeBody(id: string, body: CodeChatBody): Promise<void> {
  await bodyStore.save(id, body);
}

export async function loadCodeBody(id: string): Promise<CodeChatBody | null> {
  const b = await bodyStore.load(id);
  // Pre-AI-SDK bodies stored `steps` (no `messages`) — treat as unrecognized (reset, per migration).
  if (!Array.isArray(b?.messages)) return null;
  return {
    messages: b.messages,
    cwd: b.cwd ?? "",
    harnessId: b.harnessId ?? "",
    modelId: b.modelId ?? "",
    // Legacy bodies carry only modelId — those were always Anthropic picks.
    model: b.model ?? (b.modelId ? fromLegacyModelId(b.modelId) : undefined),
    // Retired "default" (Ask each time) mode — headless CLIs can't prompt; coerce to acceptEdits.
    permissionMode: b.permissionMode && b.permissionMode !== "default" ? b.permissionMode : "acceptEdits",
    effort: b.effort ?? "auto",
    title: b.title ?? "",
  };
}

export const deleteCodeBody = bodyStore.del;

// Concatenate the text parts of a message (the user prompt is plain text).
function messageText(m: UIMessage): string {
  return (m.parts as { type: string; text?: string }[])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// Build an index entry from the transcript: title/preview from the first user message's prompt.
export function codeIndexEntryFrom(id: string, messages: UIMessage[], createdAt: number, title?: string, cwd?: string): ChatIndexEntry | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null; // skip empty code chats
  const snippet = messageText(firstUser).trim().replace(/\s+/g, " ");
  return {
    id,
    title: title?.trim() || snippet.slice(0, 60) || "New session",
    modelId: "",
    preview: snippet.slice(0, 120),
    createdAt,
    updatedAt: Date.now(),
    cwd: cwd || "",
  };
}
