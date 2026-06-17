// generateTitle.ts — name a new chat from its first exchange via a cheap backend.
// Best-effort: failure/offline → "" (caller keeps first-message fallback). In the page: drives streamLLM.
import { TITLE_PROMPT } from "@/shared/config/prompts";
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import type { Backend } from "@/entities/model/model/backend";

export async function generateTitle(firstUser: string, firstAssistant: string, backend: Backend): Promise<string> {
  if (backend.kind === "none") return "";
  const prompt = TITLE_PROMPT + `User: ${firstUser}\nAssistant: ${firstAssistant}`;
  let out = "";
  try {
    for await (const d of streamLLM(backend, [{ role: "user", content: prompt }])) {
      if (d.kind === "text") out += d.text;
    }
  } catch {
    return "";
  }
  return cleanTitle(out);
}

// Take the first line and strip quotes/backticks/trailing punctuation the model may add.
function cleanTitle(raw: string): string {
  const firstLine = raw.trim().split("\n")[0];
  return firstLine
    .replace(/^["'`“”*\s]+|["'`“”*\s]+$/g, "")
    .replace(/[.,;:]+$/, "")
    .slice(0, 60)
    .trim();
}
