// parse.ts — salvage the durable-facts JSON array out of a cheap model's reply.
import type { MemoryKind } from "@/entities/memory/model/memory";

const KINDS = new Set<MemoryKind>(["user", "preference", "project", "fact"]);

export interface ExtractedFact {
  text: string;
  kind: MemoryKind;
}

// Salvage the JSON array even if the model wrapped it in prose or ```json fences.
export function parseFacts(raw: string): ExtractedFact[] {
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f) => f && typeof f.text === "string" && f.text.trim())
      .map((f) => ({ text: f.text.trim(), kind: KINDS.has(f.kind) ? (f.kind as MemoryKind) : "fact" }));
  } catch {
    return [];
  }
}
