// chats.ts — persisted chat history: encrypted, reactive in-RAM index + encrypted SQLite
// bodies (localStorage fallback off-Tauri). Index/title/preview are user content, so the
// localStorage blob is vault-encrypted; an in-RAM cache keeps reads synchronous for the UI.
import { useEffect, useReducer } from "react";
import type { Message } from "@/entities/model/model/registry";
import { isTauri } from "@/shared/api/tauri";
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";

// ---- Index (encrypted localStorage blob + in-RAM cache, reactive) ----

const INDEX_KEY = "orchestro.chats.index";
const EVT = "orchestro-chats-changed";

export interface ChatIndexEntry {
  id: string;
  title: string; // from the first user message
  modelId: string; // last assistant's model (sidebar subtitle)
  preview: string; // first user message snippet
  createdAt: number;
  updatedAt: number;
}

let indexCache: ChatIndexEntry[] = [];
let idxHydrated = false;
let idxHydrating: Promise<void> | null = null;

// Decrypt + load the index into RAM once. Idempotent. Tolerant of legacy plaintext.
export function hydrateChatIndex(): Promise<void> {
  if (idxHydrated) return Promise.resolve();
  if (!idxHydrating)
    idxHydrating = (async () => {
      try {
        const raw = localStorage.getItem(INDEX_KEY);
        if (raw) {
          const arr = JSON.parse(await vaultDecrypt(raw));
          if (Array.isArray(arr)) indexCache = (arr as ChatIndexEntry[]).filter((c) => c && typeof c.id === "string");
        }
      } catch {
        /* keep empty */
      }
      idxHydrated = true;
      window.dispatchEvent(new Event(EVT));
    })();
  return idxHydrating;
}

export function getChats(): ChatIndexEntry[] {
  return indexCache.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveIndex(list: ChatIndexEntry[]): void {
  indexCache = list;
  window.dispatchEvent(new Event(EVT));
  void (async () => {
    try {
      localStorage.setItem(INDEX_KEY, await vaultEncrypt(JSON.stringify(list)));
    } catch {
      /* ignore */
    }
  })();
}

export function upsertChat(entry: ChatIndexEntry): void {
  const list = getChats();
  const i = list.findIndex((c) => c.id === entry.id);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  saveIndex(list);
}

export function deleteChat(id: string): void {
  saveIndex(getChats().filter((c) => c.id !== id));
  void deleteChatBody(id);
}

// Subscribe to index changes (same-tab: custom event; cross-tab: storage).
export function useChatStore() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const h = () => force();
    window.addEventListener(EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return { getChats, upsertChat, deleteChat };
}

// ---- Body (SQLite under Tauri / localStorage fallback) ----

export interface ChatBody {
  messages: Message[];
  summary: string;
  covered: number;
  title: string; // LLM-generated; "" until generated (then falls back to first user msg)
}

const BODY_PREFIX = "orchestro.chat.";

// Lazy singleton DB handle; the `chats` migration is registered in Rust.
let dbPromise: Promise<import("@tauri-apps/plugin-sql").default> | null = null;
async function db() {
  if (!dbPromise) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    dbPromise = Database.load("sqlite:orchestro.db");
  }
  return dbPromise;
}

// Drop transient streaming state before persisting (reload renders from `text`).
// Fold a mid-stream turn's `shown` into `text`, else flush-on-switch saves an empty reply.
function sanitize(messages: Message[]): Message[] {
  return messages.map(({ shown, streaming, ...rest }) => ({ ...rest, text: rest.text || shown || "" }));
}

export async function saveChatBody(id: string, body: ChatBody): Promise<void> {
  const data = await vaultEncrypt(JSON.stringify({ ...body, messages: sanitize(body.messages) }));
  if (isTauri()) {
    try {
      const d = await db();
      await d.execute(
        "INSERT INTO chats (id, data, updated_at) VALUES ($1, $2, $3) " +
          "ON CONFLICT(id) DO UPDATE SET data = $2, updated_at = $3",
        [id, data, Date.now()]
      );
      return;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    localStorage.setItem(BODY_PREFIX + id, data);
  } catch {
    /* quota/full — drop silently */
  }
}

export async function loadChatBody(id: string): Promise<ChatBody | null> {
  let raw: string | null = null;
  if (isTauri()) {
    try {
      const d = await db();
      const rows = await d.select<{ data: string }[]>("SELECT data FROM chats WHERE id = $1", [id]);
      raw = rows[0]?.data ?? null;
    } catch {
      raw = null;
    }
  }
  if (raw === null) raw = localStorage.getItem(BODY_PREFIX + id); // browser / fallback-saved body
  if (!raw) return null;
  try {
    const b = JSON.parse(await vaultDecrypt(raw));
    if (!Array.isArray(b?.messages)) return null;
    return { messages: b.messages, summary: b.summary ?? "", covered: b.covered ?? 0, title: b.title ?? "" };
  } catch {
    return null;
  }
}

export async function deleteChatBody(id: string): Promise<void> {
  if (isTauri()) {
    try {
      const d = await db();
      await d.execute("DELETE FROM chats WHERE id = $1", [id]);
      return;
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(BODY_PREFIX + id);
  } catch {
    /* ignore */
  }
}

// Build an index entry. Title: LLM-generated if available, else "New chat" until `settled`,
// then the first user turn. Preview from first user turn, modelId from last assistant.
export function indexEntryFrom(
  id: string,
  messages: Message[],
  createdAt: number,
  title?: string,
  settled?: boolean
): ChatIndexEntry | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null; // skip empty chats
  const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
  const firstMsg = firstUser.text.trim().replace(/\s+/g, " ").slice(0, 60);
  const fallback = (settled && firstMsg) || "New chat";
  return {
    id,
    title: title?.trim() || fallback,
    modelId: lastAsst?.decision?.chosen.id || lastAsst?.modelLabel || "",
    preview: firstUser.text.trim().replace(/\s+/g, " ").slice(0, 120),
    createdAt,
    updatedAt: Date.now(),
  };
}
