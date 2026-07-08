// chats.ts — persisted chat history: encrypted, reactive in-RAM index + encrypted SQLite
// bodies (localStorage fallback off-Tauri). Index/title/preview are user content, so the
// localStorage blob is vault-encrypted; an in-RAM cache keeps reads synchronous for the UI.
import { useEffect, useReducer } from "react";
import type { Message } from "@/entities/model/model/registry";
import { isTauri } from "@/shared/api/tauri";
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";

// ---- Index (encrypted localStorage blob + in-RAM cache, reactive) ----

const INDEX_KEY = "modelius.chats.index";
const EVT = "modelius-chats-changed";

export interface ChatIndexEntry {
  id: string;
  title: string; // from the first user message
  modelId: string; // last assistant's model (sidebar subtitle)
  preview: string; // first user message snippet
  createdAt: number;
  updatedAt: number;
  pinned?: boolean; // user-pinned → floats to its own section
  cwd?: string; // Code mode only: project folder — the sidebar groups sessions by it
}

// Index-store factory: encrypted localStorage blob + in-RAM cache, reactive via a window event.
// Also instantiated by codeChats.ts (Code mode's index — same behavior, separate namespace).
export function makeChatIndexStore(indexKey: string, evt: string, deleteBody: (id: string) => Promise<void>) {
  let cache: ChatIndexEntry[] = [];
  let sorted: ChatIndexEntry[] | null = null; // memoized getAll() result; reset on every write
  let hydrated = false;
  let hydrating: Promise<void> | null = null;
  // A title set by the user via rename is sticky: it survives index rebuilds from session
  // persistence (which would otherwise re-derive the title from the chat content).
  const renamed = new Set<string>();

  // Decrypt + load the index into RAM once. Idempotent. Tolerant of legacy plaintext.
  function hydrate(): Promise<void> {
    if (hydrated) return Promise.resolve();
    if (!hydrating)
      hydrating = (async () => {
        try {
          const raw = localStorage.getItem(indexKey);
          if (raw) {
            const arr = JSON.parse(await vaultDecrypt(raw));
            if (Array.isArray(arr)) {
              cache = (arr as ChatIndexEntry[]).filter((c) => c && typeof c.id === "string");
              sorted = null;
            }
          }
        } catch {
          /* keep empty */
        }
        hydrated = true;
        window.dispatchEvent(new Event(evt));
      })();
    return hydrating;
  }

  function getAll(): ChatIndexEntry[] {
    if (!sorted) sorted = cache.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted;
  }

  function save(list: ChatIndexEntry[]): void {
    cache = list;
    sorted = null;
    window.dispatchEvent(new Event(evt));
    void (async () => {
      try {
        localStorage.setItem(indexKey, await vaultEncrypt(JSON.stringify(list)));
      } catch {
        /* ignore */
      }
    })();
  }

  function upsert(entry: ChatIndexEntry): void {
    const list = getAll().slice();
    const i = list.findIndex((c) => c.id === entry.id);
    if (i >= 0) {
      // Carry over user-set state that session persistence doesn't know about.
      const prev = list[i];
      list[i] = {
        ...entry,
        pinned: entry.pinned ?? prev.pinned,
        title: renamed.has(entry.id) ? prev.title : entry.title,
      };
    } else list.push(entry);
    save(list);
  }

  function del(id: string): void {
    renamed.delete(id);
    save(getAll().filter((c) => c.id !== id));
    void deleteBody(id);
  }

  // Pin/unpin a chat (floats it into the Pinned section).
  function pin(id: string, pinned: boolean): void {
    save(getAll().map((c) => (c.id === id ? { ...c, pinned } : c)));
  }

  // Rename a chat; the new title becomes sticky against later content-derived rebuilds.
  function rename(id: string, title: string): void {
    const t = title.trim();
    if (!t) return;
    renamed.add(id);
    save(getAll().map((c) => (c.id === id ? { ...c, title: t } : c)));
  }

  // Subscribe to index changes (same-tab: custom event; cross-tab: storage).
  function useSubscribe(): void {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
      const h = () => force();
      window.addEventListener(evt, h);
      window.addEventListener("storage", h);
      return () => {
        window.removeEventListener(evt, h);
        window.removeEventListener("storage", h);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  }

  return { hydrate, getAll, upsert, del, pin, rename, useSubscribe };
}

const store = makeChatIndexStore(INDEX_KEY, EVT, (id) => deleteChatBody(id));

export const hydrateChatIndex = store.hydrate;
export const getChats = store.getAll;
export const upsertChat = store.upsert;
export const deleteChat = store.del;
export const pinChat = store.pin;
export const renameChat = store.rename;

export function useChatStore() {
  store.useSubscribe();
  return { getChats, upsertChat, deleteChat, pinChat, renameChat };
}

// ---- Body (SQLite under Tauri / localStorage fallback) ----

export interface ChatBody {
  messages: Message[];
  summary: string;
  covered: number;
  title: string; // LLM-generated; "" until generated (then falls back to first user msg)
  customPrompt?: string; // per-chat persona; overrides the global custom instructions. "" = inherit
  siblings?: Message[][]; // inactive alternative threads (branching)
}

const BODY_PREFIX = "modelius.chat.";

// Lazy singleton DB handle; the `chats` migration is registered in Rust.
// Exported so the code-chats store can share the same connection (its rows live in the same table).
let dbPromise: Promise<import("@tauri-apps/plugin-sql").default> | null = null;
export async function db() {
  if (!dbPromise) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    dbPromise = Database.load("sqlite:modelius.db");
  }
  return dbPromise;
}

// Body-store factory: encrypted rows in the shared `chats` SQLite table (localStorage fallback,
// keyed by `prefix`). Also instantiated by codeChats.ts. load() returns parsed-but-unvalidated
// JSON — each caller validates its own body shape.
export function makeBodyStore(prefix: string) {
  async function save(id: string, value: unknown): Promise<void> {
    const data = await vaultEncrypt(JSON.stringify(value));
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
      localStorage.setItem(prefix + id, data);
    } catch {
      /* quota/full — drop silently */
    }
  }

  async function load(id: string): Promise<any | null> {
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
    if (raw === null) raw = localStorage.getItem(prefix + id); // browser / fallback-saved body
    if (!raw) return null;
    try {
      return JSON.parse(await vaultDecrypt(raw));
    } catch {
      return null;
    }
  }

  async function del(id: string): Promise<void> {
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
      localStorage.removeItem(prefix + id);
    } catch {
      /* ignore */
    }
  }

  return { save, load, del };
}

const bodyStore = makeBodyStore(BODY_PREFIX);

// Drop transient streaming state before persisting (reload renders from `text`).
// Fold a mid-stream turn's `shown` into `text`, else flush-on-switch saves an empty reply.
function sanitize(messages: Message[]): Message[] {
  return messages.map(({ shown, streaming, ...rest }) => ({ ...rest, text: rest.text || shown || "" }));
}

export async function saveChatBody(id: string, body: ChatBody): Promise<void> {
  const siblings = body.siblings?.length ? body.siblings.map(sanitize) : undefined;
  await bodyStore.save(id, { ...body, messages: sanitize(body.messages), siblings });
}

export async function loadChatBody(id: string): Promise<ChatBody | null> {
  const b = await bodyStore.load(id);
  if (!Array.isArray(b?.messages)) return null;
  return { messages: b.messages, summary: b.summary ?? "", covered: b.covered ?? 0, title: b.title ?? "", customPrompt: b.customPrompt ?? "", siblings: Array.isArray(b.siblings) ? b.siblings : undefined };
}

export const deleteChatBody = bodyStore.del;

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
