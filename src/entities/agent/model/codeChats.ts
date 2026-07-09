// codeChats.ts — persisted Code-mode chat history, parallel to entities/chat/model/chats.ts.
// Separate namespace (own index key/event, own body prefix) so it never touches Chat persistence,
// but shares the `chats` SQLite table (UUID keys, opaque encrypted `data` — no row collision).
// The store mechanics live in chats.ts's factories; this module is configuration + body shape.
import { makeChatIndexStore, makeBodyStore, type ChatIndexEntry } from "@/entities/chat/model/chats";
import type { Step } from "@/features/run-agent/lib/agentChannel";
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

export interface CodeChatBody {
  steps: Step[];
  cwd: string;
  harnessId: string;
  modelId: string; // kept alongside `model` so pre-routing builds can still open the chat
  model?: CodeModelChoice;
  permissionMode: string;
  resumeId?: string; // the CLI's session id from the last run — next turn resumes it
  contextTokens?: number; // last run's stats, restored into the header on reopen
  cost?: number | null;
  title: string;
}

const BODY_PREFIX = "modelius.code.";
const bodyStore = makeBodyStore(BODY_PREFIX);

export async function saveCodeBody(id: string, body: CodeChatBody): Promise<void> {
  await bodyStore.save(id, body);
}

export async function loadCodeBody(id: string): Promise<CodeChatBody | null> {
  const b = await bodyStore.load(id);
  if (!Array.isArray(b?.steps)) return null;
  return {
    steps: b.steps,
    cwd: b.cwd ?? "",
    harnessId: b.harnessId ?? "",
    modelId: b.modelId ?? "",
    // Legacy bodies carry only modelId — those were always Anthropic picks.
    model: b.model ?? (b.modelId ? fromLegacyModelId(b.modelId) : undefined),
    // Migrate old bodies: boolean acceptEdits, and the retired "default" (Ask each time) mode —
    // headless CLIs can't prompt, so it silently denied; coerce to acceptEdits.
    permissionMode: b.permissionMode && b.permissionMode !== "default" ? b.permissionMode : "acceptEdits",
    resumeId: b.resumeId,
    contextTokens: b.contextTokens,
    cost: b.cost,
    title: b.title ?? "",
  };
}

export const deleteCodeBody = bodyStore.del;

// Build an index entry from the transcript: title/preview from the first user step's prompt.
export function codeIndexEntryFrom(id: string, steps: Step[], createdAt: number, title?: string, cwd?: string): ChatIndexEntry | null {
  const firstUser = steps.find((s): s is Extract<Step, { type: "user" }> => s.type === "user");
  if (!firstUser) return null; // skip empty code chats
  const snippet = firstUser.text.trim().replace(/\s+/g, " ");
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
