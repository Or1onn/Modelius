// parse.ts — salvage the memory-reconciliation operations out of a cheap model's reply.
import type { MemoryKind } from "@/entities/memory/model/memory";

const KINDS = new Set<MemoryKind>(["user", "preference", "project", "fact"]);

// Raw op as emitted by the model: update/delete reference a known fact by #ref (1-based).
export type RawMemoryOp =
  | { op: "add"; text: string; kind: MemoryKind }
  | { op: "update"; ref: number; text: string; kind?: MemoryKind }
  | { op: "delete"; ref: number };

const kindOf = (k: unknown): MemoryKind => (KINDS.has(k as MemoryKind) ? (k as MemoryKind) : "fact");

// Salvage the array even if wrapped in prose or ```json fences; drop malformed ops.
export function parseMemoryOps(raw: string): RawMemoryOp[] {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const ops: RawMemoryOp[] = [];
  for (const o of arr) {
    if (!o || typeof o !== "object") continue;
    const op = (o as { op?: unknown }).op;
    const text = typeof (o as { text?: unknown }).text === "string" ? (o as { text: string }).text.trim() : "";
    const ref = Number((o as { ref?: unknown }).ref);
    if (op === "delete") {
      if (Number.isInteger(ref)) ops.push({ op: "delete", ref });
    } else if (op === "update") {
      if (Number.isInteger(ref) && text) ops.push({ op: "update", ref, text, kind: kindOf((o as { kind?: unknown }).kind) });
    } else {
      // default/"add": needs text
      if (text) ops.push({ op: "add", text, kind: kindOf((o as { kind?: unknown }).kind) });
    }
  }
  return ops;
}
