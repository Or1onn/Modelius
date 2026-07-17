// collectText.ts — run a one-shot prompt through streamLLM and accumulate the text deltas.
// Shared by the background helpers (summarize / title / memory-extract / classify). Throws what
// the stream throws; callers own their fallback.
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import type { Backend } from "@/entities/model/model/backend";
import type { EffortLevel } from "@/entities/model/model/apiIds";

export async function collectText(
  backend: Backend,
  prompt: string,
  opts?: { effort?: EffortLevel | "auto"; signal?: AbortSignal }
): Promise<string> {
  let out = "";
  for await (const d of streamLLM(backend, [{ role: "user", content: prompt }], false, opts?.effort ?? "auto", false, opts?.signal)) {
    if (d.kind === "text") out += d.text;
  }
  return out;
}
