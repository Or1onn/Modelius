// memory.ts — persisted, reactive long-term memory store (localStorage-backed).
// Durable facts about the user, injected into every chat's system prompt so the
// assistant "remembers" across sessions (LLMs are stateless — the client holds it).
import { useEffect, useReducer } from "react";
import { estimateTokens } from "@/shared/lib/tokens";

const STORAGE_KEY = "orchestro.memory";
const EVT = "orchestro-memory-changed";

export type MemoryKind = "user" | "preference" | "project" | "fact";

export interface Memory {
  id: string;
  text: string; // the fact, one line, third person
  kind: MemoryKind;
  enabled: boolean; // disabled facts stay listed but aren't injected
  createdAt: number;
}

// Display order + labels per kind (also drives the screen's grouping).
export const MEMORY_KINDS: { id: MemoryKind; label: string }[] = [
  { id: "user", label: "About you" },
  { id: "preference", label: "Preferences" },
  { id: "project", label: "Projects" },
  { id: "fact", label: "Other facts" },
];

const VALID_KINDS = new Set<MemoryKind>(["user", "preference", "project", "fact"]);

export function getMemories(): Memory[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((m): m is Memory => m && typeof m.text === "string" && VALID_KINDS.has(m.kind));
  } catch {
    return [];
  }
}

function save(list: Memory[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVT));
}

// Normalized text for dedup: a new fact matching an existing one (case/space-
// insensitive) is dropped rather than duplicated.
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function hasMemory(text: string): boolean {
  const n = norm(text);
  return getMemories().some((m) => norm(m.text) === n);
}

// Returns true if the fact was actually stored (false when blank or a duplicate).
export function addMemory(text: string, kind: MemoryKind = "fact"): boolean {
  const t = text.trim();
  if (!t || hasMemory(t)) return false;
  const m: Memory = { id: crypto.randomUUID(), text: t, kind, enabled: true, createdAt: Date.now() };
  save([...getMemories(), m]);
  return true;
}

export function updateMemory(id: string, patch: Partial<Pick<Memory, "text" | "kind" | "enabled">>): void {
  save(getMemories().map((m) => (m.id === id ? { ...m, ...patch } : m)));
}

export function deleteMemory(id: string): void {
  save(getMemories().filter((m) => m.id !== id));
}

export function clearMemories(): void {
  save([]);
}

// The injectable memory block: enabled facts only, grouped by kind, capped by
// tokens so a large memory never crowds out the conversation. "" when empty.
const MEMORY_TOKEN_CAP = 800;
export function memoryBlock(): string {
  const enabled = getMemories().filter((m) => m.enabled);
  if (!enabled.length) return "";
  const lines: string[] = [];
  for (const k of MEMORY_KINDS) {
    const items = enabled.filter((m) => m.kind === k.id);
    if (!items.length) continue;
    lines.push(`${k.label}:`);
    for (const m of items) lines.push(`- ${m.text}`);
  }
  let out = lines.join("\n");
  if (estimateTokens(out) > MEMORY_TOKEN_CAP) out = out.slice(0, MEMORY_TOKEN_CAP * 4).trimEnd();
  return out;
}

// Subscribe to memory changes (same-tab via custom event, other tabs via storage).
export function useMemoryStore() {
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
  return { getMemories, addMemory, updateMemory, deleteMemory, clearMemories };
}
