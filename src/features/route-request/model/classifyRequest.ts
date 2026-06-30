// classifyRequest.ts — hybrid request classifier for smart routing.
// Heuristic first; when it's unsure, refine difficulty with a cheap LLM call (subscription-
// preferred, sampled + timed-out). Best-effort: any failure falls back to the heuristic.
import { classify, classificationFor, route } from "./route";
import { ROUTE_CLASSIFY_PROMPT } from "@/shared/config/prompts";
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import { pickSummarizerBackend } from "@/features/pick-backend/model/pickBackend";
import type { Classification, Model } from "@/entities/model/model/registry";

const KINDS: Classification["kind"][] = ["trivial", "general", "code", "complex"];
const TIMEOUT_MS = 1500;
const cache = new Map<string, Classification>();

// Classify a request, escalating to the LLM only for ambiguous auto-routes with a backend.
export async function classifyRequest(text: string, opts?: { pool?: Model[] }): Promise<Classification> {
  const heur = classify(text);
  if (heur.confident || !opts?.pool?.length) return heur; // sure, or nothing connected → heuristic

  const key = String(text.length) + ":" + hash(text);
  const hit = cache.get(key);
  if (hit) return hit;

  const backend = pickSummarizerBackend(route(ROUTE_CLASSIFY_PROMPT, "cost"));
  if (backend.kind === "none") return heur;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let out = "";
    for await (const d of streamLLM(backend, [{ role: "user", content: ROUTE_CLASSIFY_PROMPT + sample(text) }], false, "low", false, ctrl.signal)) {
      if (d.kind === "text") out += d.text;
    }
    const parsed = parse(out);
    if (parsed) {
      cache.set(key, parsed);
      return parsed;
    }
  } catch {
    /* offline / aborted / stream error — fall through to heuristic */
  } finally {
    clearTimeout(timer);
  }
  return heur;
}

// Difficulty needs the gist, not the whole paste — head+tail keeps big inputs cheap & fast.
function sample(text: string): string {
  if (text.length <= 4000) return text;
  return text.slice(0, 3000) + "\n…\n" + text.slice(-1000);
}

function parse(raw: string): Classification | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: { difficulty?: unknown; kind?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const kind = KINDS.includes(obj.kind as Classification["kind"]) ? (obj.kind as Classification["kind"]) : null;
  const difficulty = typeof obj.difficulty === "number" ? Math.max(0, Math.min(100, Math.round(obj.difficulty))) : null;
  if (!kind || difficulty == null) return null;
  return classificationFor(kind, difficulty, true);
}

// djb2 — cheap, stable cache key over the sampled request.
function hash(s: string): string {
  let h = 5381;
  const t = sample(s);
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
