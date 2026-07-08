// codeChats.ts — persisted Code-mode chat history, parallel to entities/chat/model/chats.ts.
// Separate namespace (own index key/event, own body prefix) so it never touches Chat persistence,
// but shares the `chats` SQLite table (UUID keys, opaque encrypted `data` — no row collision).
import { useEffect, useReducer } from "react";
import { isTauri } from "@/shared/api/tauri";
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";
import { db, type ChatIndexEntry } from "@/entities/chat/model/chats";
import type { Step } from "@/features/run-agent/lib/agentChannel";
import { fromLegacyModelId, type CodeModelChoice } from "@/entities/agent/model/codeModel";

// ---- Index (encrypted localStorage blob + in-RAM cache, reactive) ----

const INDEX_KEY = "modelius.code.index";
const EVT = "modelius-code-changed";

// Reuse ChatIndexEntry — same shape the sidebar (ChatGroup/ChatRow) already renders.
export type { ChatIndexEntry };

let indexCache: ChatIndexEntry[] = [];
let idxHydrated = false;
let idxHydrating: Promise<void> | null = null;

export function hydrateCodeIndex(): Promise<void> {
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

export function getCodeChats(): ChatIndexEntry[] {
  return indexCache.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

const renamed = new Set<string>();

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

export function upsertCodeChat(entry: ChatIndexEntry): void {
  const list = getCodeChats();
  const i = list.findIndex((c) => c.id === entry.id);
  if (i >= 0) {
    const prev = list[i];
    list[i] = {
      ...entry,
      pinned: entry.pinned ?? prev.pinned,
      title: renamed.has(entry.id) ? prev.title : entry.title,
    };
  } else list.push(entry);
  saveIndex(list);
}

export function deleteCodeChat(id: string): void {
  renamed.delete(id);
  saveIndex(getCodeChats().filter((c) => c.id !== id));
  void deleteCodeBody(id);
}

export function pinCodeChat(id: string, pinned: boolean): void {
  saveIndex(getCodeChats().map((c) => (c.id === id ? { ...c, pinned } : c)));
}

export function renameCodeChat(id: string, title: string): void {
  const t = title.trim();
  if (!t) return;
  renamed.add(id);
  saveIndex(getCodeChats().map((c) => (c.id === id ? { ...c, title: t } : c)));
}

// Subscribe to code-index changes (same-tab: custom event; cross-tab: storage).
export function useCodeChatStore() {
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
  title: string;
}

const BODY_PREFIX = "modelius.code.";

export async function saveCodeBody(id: string, body: CodeChatBody): Promise<void> {
  const data = await vaultEncrypt(JSON.stringify(body));
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

export async function loadCodeBody(id: string): Promise<CodeChatBody | null> {
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
  if (raw === null) raw = localStorage.getItem(BODY_PREFIX + id);
  if (!raw) return null;
  try {
    const b = JSON.parse(await vaultDecrypt(raw));
    if (!Array.isArray(b?.steps)) return null;
    return {
      steps: b.steps,
      cwd: b.cwd ?? "",
      harnessId: b.harnessId ?? "",
      modelId: b.modelId ?? "",
      // Legacy bodies carry only modelId — those were always Anthropic picks.
      model: b.model ?? (b.modelId ? fromLegacyModelId(b.modelId) : undefined),
      // Migrate old bodies that stored a boolean acceptEdits.
      permissionMode: b.permissionMode ?? (b.acceptEdits === false ? "default" : "acceptEdits"),
      title: b.title ?? "",
    };
  } catch {
    return null;
  }
}

export async function deleteCodeBody(id: string): Promise<void> {
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
