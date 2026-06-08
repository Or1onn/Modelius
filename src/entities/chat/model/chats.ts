// chats.ts — persisted chat history: localStorage index (reactive, for the sidebar)
// + SQLite chat bodies via tauri-plugin-sql (document-per-chat), with a localStorage
// fallback when not running under Tauri (e.g. `npm run dev` in a browser).
import { useEffect, useReducer } from "react";
import type { Message } from "@/entities/model/model/registry";
import { isTauri } from "@/shared/api/tauri";

// ---- Index (localStorage, reactive — mirrors memory.ts) ----------------------

const INDEX_KEY = "orchestro.chats.index";
const EVT = "orchestro-chats-changed";

export interface ChatIndexEntry {
  id: string;
  title: string; // derived from the first user message
  modelId: string; // last assistant's routed/manual model, for the sidebar subtitle
  preview: string; // short snippet of the first user message
  createdAt: number;
  updatedAt: number;
}

export function getChats(): ChatIndexEntry[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return (arr as ChatIndexEntry[])
      .filter((c) => c && typeof c.id === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function saveIndex(list: ChatIndexEntry[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVT));
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

// Subscribe to index changes (same-tab via custom event, other tabs via storage).
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

// ---- Body (SQLite under Tauri / localStorage fallback) -----------------------

export interface ChatBody {
  messages: Message[];
  summary: string;
  covered: number;
}

const BODY_PREFIX = "orchestro.chat.";

// Lazy singleton DB handle; the migration that creates `chats` is registered in Rust.
let dbPromise: Promise<import("@tauri-apps/plugin-sql").default> | null = null;
async function db() {
  if (!dbPromise) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    dbPromise = Database.load("sqlite:orchestro.db");
  }
  return dbPromise;
}

// Drop transient streaming state before persisting; on reload we render from `text`.
function sanitize(messages: Message[]): Message[] {
  return messages.map(({ shown, streaming, ...rest }) => rest);
}

export async function saveChatBody(id: string, body: ChatBody): Promise<void> {
  const data = JSON.stringify({ ...body, messages: sanitize(body.messages) });
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
  if (raw === null) raw = localStorage.getItem(BODY_PREFIX + id); // browser, or recover a fallback-saved body
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (!Array.isArray(b?.messages)) return null;
    return { messages: b.messages, summary: b.summary ?? "", covered: b.covered ?? 0 };
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

// Build an index entry from a chat's messages (title/preview from the first user turn,
// modelId from the last assistant's decision or manual label).
export function indexEntryFrom(id: string, messages: Message[], createdAt: number): ChatIndexEntry | null {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return null; // don't index empty chats
  const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
  const title = firstUser.text.trim().replace(/\s+/g, " ").slice(0, 60) || "New chat";
  return {
    id,
    title,
    modelId: lastAsst?.decision?.chosen.id || lastAsst?.modelLabel || "",
    preview: firstUser.text.trim().replace(/\s+/g, " ").slice(0, 120),
    createdAt,
    updatedAt: Date.now(),
  };
}
