// branchName.ts — an English git branch name for a Code chat's isolated worktree, derived from the
// first prompt by the same cheap backend that names chats. The worktree is cut before the turn
// starts, so this is the only text available. Best-effort: no backend, offline, or slow → "" and
// the caller passes the raw prompt instead (the Rust slugifier transliterates it).
import { BRANCH_PROMPT } from "@/shared/config/prompts";
import { collectText } from "@/features/stream-completion/lib/collectText";
import { pickSummarizerBackend } from "@/features/pick-backend/model/pickBackend";
import { route } from "@/features/route-request/model/route";

const TIMEOUT_MS = 6000; // this blocks the first send — give up rather than stall the turn
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function generateBranchName(prompt: string): Promise<string> {
  const text = prompt.trim();
  if (!text) return "";
  const backend = pickSummarizerBackend(route(BRANCH_PROMPT, "cost"));
  if (backend.kind === "none") return "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const out = await collectText(backend, BRANCH_PROMPT + text.slice(0, 600), { signal: ctrl.signal });
    return cleanBranchName(out);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// The model is asked for a bare slug; tolerate the usual deviations (quotes, a `fix/` prefix, a
// sentence around it). "" when nothing usable came back — the caller then falls back to the prompt.
export function cleanBranchName(raw: string): string {
  const lines = raw
    .trim()
    .toLowerCase()
    .split("\n")
    .map((l) =>
      l
        .replace(/^["'`*\s]+|["'`*\s]+$/g, "")
        .replace(/[.,;:]+$/, "")
        .replace(/^[a-z]+\//, "") // a conventional-commit prefix the prompt asked it not to add
    );
  const slug = lines.find((l) => l.length <= 40 && SLUG.test(l));
  if (slug) return slug;
  // Prose answer: keep the first line's leading words. Rough, but still a readable branch.
  const words = (lines[0] ?? "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join("-");
}
