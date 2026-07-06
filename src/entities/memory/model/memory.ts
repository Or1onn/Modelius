// memory.ts — reactive long-term memory store: durable user facts injected into every
// system prompt. Persisted as a vault-encrypted localStorage blob (facts are user content);
// an in-RAM cache keeps reads synchronous for the UI and the prompt builder.
import { useEffect, useReducer } from "react";
import { estimateTokens } from "@/shared/lib/tokens";
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";

const STORAGE_KEY = "modelius.memory";
const EVT = "modelius-memory-changed";

export type MemoryKind = "user" | "preference" | "project" | "fact";

export interface Memory {
  id: string;
  text: string; // one line, third person
  kind: MemoryKind;
  enabled: boolean; // disabled → listed but not injected
  createdAt: number;
}

// Display order + labels per kind (drives screen grouping).
export const MEMORY_KINDS: { id: MemoryKind; label: string }[] = [
  { id: "user", label: "About you" },
  { id: "preference", label: "Preferences" },
  { id: "project", label: "Projects" },
  { id: "fact", label: "Other facts" },
];

const VALID_KINDS = new Set<MemoryKind>(["user", "preference", "project", "fact"]);
const isMemory = (m: unknown): m is Memory =>
  !!m && typeof (m as Memory).text === "string" && VALID_KINDS.has((m as Memory).kind);

let cache: Memory[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;

// Decrypt + load memory into RAM once. Idempotent. Tolerant of legacy plaintext.
export function hydrateMemory(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydrating)
    hydrating = (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const arr = JSON.parse(await vaultDecrypt(raw));
          if (Array.isArray(arr)) cache = arr.filter(isMemory);
        }
      } catch {
        /* keep empty */
      }
      hydrated = true;
      window.dispatchEvent(new Event(EVT));
    })();
  return hydrating;
}

export function getMemories(): Memory[] {
  return cache.slice();
}

function save(list: Memory[]): void {
  cache = list;
  window.dispatchEvent(new Event(EVT));
  void (async () => {
    try {
      localStorage.setItem(STORAGE_KEY, await vaultEncrypt(JSON.stringify(list)));
    } catch {
      /* ignore */
    }
  })();
}

// Normalized text for case/space-insensitive dedup.
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function hasMemory(text: string): boolean {
  const n = norm(text);
  return getMemories().some((m) => norm(m.text) === n);
}

// True if stored (false when blank or a duplicate).
export function addMemory(text: string, kind: MemoryKind = "fact"): boolean {
  const t = text.trim();
  if (!t || hasMemory(t)) return false;
  const m: Memory = { id: crypto.randomUUID(), text: t, kind, enabled: true, createdAt: Date.now() };
  save([...getMemories(), m]);
  return true;
}

// ---- Reconciliation (extractor-driven upsert) ----

// Word-set Jaccard similarity — the safety net that collapses a reworded "add" into an
// update of the closest existing fact when the extractor fails to reference it.
const tokenize = (s: string) => norm(s).split(" ").filter(Boolean);
function similarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const SIMILAR = 0.6; // ≥ this → treat a new fact as an update of the closest existing one

function closest(text: string): { m: Memory; sim: number } | null {
  let best: { m: Memory; sim: number } | null = null;
  for (const m of getMemories()) {
    const sim = similarity(text, m.text);
    if (!best || sim > best.sim) best = { m, sim };
  }
  return best;
}

// Resolved op (refs already mapped to ids by the extractor).
export type MemoryOp =
  | { op: "add"; text: string; kind: MemoryKind }
  | { op: "update"; id: string; text: string; kind?: MemoryKind }
  | { op: "delete"; id: string };

// True when applying text/kind to an existing fact would actually change it (else it's a no-op write).
function differs(m: Memory, text: string, kind?: MemoryKind): boolean {
  return norm(m.text) !== norm(text) || (kind !== undefined && m.kind !== kind);
}

// Apply extractor ops; returns the added/updated texts (for the "Memory updated" note).
export function applyMemoryOps(ops: MemoryOp[]): string[] {
  const changed: string[] = [];
  for (const op of ops) {
    if (op.op === "delete") {
      deleteMemory(op.id);
      continue;
    }
    const text = op.text.trim();
    if (!text) continue;
    if (op.op === "update") {
      const m = getMemories().find((m) => m.id === op.id);
      if (m) {
        // Re-emitted identical fact → no-op, don't flag the note.
        if (!differs(m, text, op.kind)) continue;
        updateMemory(op.id, op.kind ? { text, kind: op.kind } : { text });
        changed.push(text);
      } else if (addMemory(text, op.kind ?? "fact")) {
        changed.push(text);
      }
      continue;
    }
    // add — collapse a near-duplicate into an update of the closest existing fact.
    const near = closest(text);
    if (near && near.sim >= SIMILAR) {
      if (!differs(near.m, text, op.kind)) continue;
      updateMemory(near.m.id, { text, kind: op.kind });
      changed.push(text);
    } else if (addMemory(text, op.kind)) {
      changed.push(text);
    }
  }
  return changed;
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

// Injectable block: enabled facts grouped by kind, token-capped so it can't crowd out the chat. "" when empty.
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

// Subscribe to memory changes (same-tab: custom event; cross-tab: storage).
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
