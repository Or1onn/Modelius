// extractMemories.ts — pull durable user facts from a finished turn via a cheap
// backend, for the long-term memory store. Best-effort: any failure → no facts.
// Lives in the chat page because it drives streamLLM (kept out of the features ring).
import { MEMORY_EXTRACT_PROMPT } from "@/shared/config/prompts";
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import { parseFacts, type ExtractedFact } from "@/features/extract-memory/lib/parse";
import type { Backend } from "@/entities/model/model/backend";
import type { Memory } from "@/entities/memory/model/memory";

export async function extractMemories(
  lastUser: string,
  lastAssistant: string,
  existing: Memory[],
  backend: Backend
): Promise<ExtractedFact[]> {
  if (backend.kind === "none") return [];
  const known = existing.length ? existing.map((m) => `- ${m.text}`).join("\n") : "(none yet)";
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
  return parseFacts(out);
}
