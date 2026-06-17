// extractMemories.ts — reconcile long-term memory against a finished turn via a cheap backend.
// Best-effort: any failure → no ops. In the page because it drives streamLLM.
import { MEMORY_EXTRACT_PROMPT } from "@/shared/config/prompts";
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import { parseMemoryOps } from "@/features/extract-memory/lib/parse";
import type { Backend } from "@/entities/model/model/backend";
import type { Memory, MemoryOp } from "@/entities/memory/model/memory";

export async function extractMemories(
  lastUser: string,
  lastAssistant: string,
  existing: Memory[],
  backend: Backend
): Promise<MemoryOp[]> {
  if (backend.kind === "none") return [];
  // Tag each known fact with a 1-based #ref so the model can update/delete it.
  const known = existing.length
    ? existing.map((m, i) => `#${i + 1} [${m.kind}] ${m.text}`).join("\n")
    : "(none yet)";
  const prompt =
    MEMORY_EXTRACT_PROMPT + `Known facts:\n${known}\n\nLatest exchange:\nUser: ${lastUser}\nAssistant: ${lastAssistant}`;
  let out = "";
  try {
    for await (const d of streamLLM(backend, [{ role: "user", content: prompt }])) {
      if (d.kind === "text") out += d.text;
    }
  } catch {
    return [];
  }
  // Map #ref → real memory id; drop ops with an out-of-range ref.
  const ops: MemoryOp[] = [];
  for (const op of parseMemoryOps(out)) {
    if (op.op === "add") {
      ops.push({ op: "add", text: op.text, kind: op.kind });
    } else {
      const m = existing[op.ref - 1];
      if (!m) continue;
      if (op.op === "delete") ops.push({ op: "delete", id: m.id });
      else ops.push({ op: "update", id: m.id, text: op.text, kind: op.kind });
    }
  }
  return ops;
}
