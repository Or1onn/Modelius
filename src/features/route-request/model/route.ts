// route.ts — classifier + scoring engine: pick the best model under a policy. Pure, deterministic.
import {
  MODELS,
  MODEL_BY_ID,
  type Model,
  type PolicyId,
  type Classification,
  type Candidate,
  type Decision,
} from "@/entities/model/model/registry";
import { estimateTokens, ctxTokens } from "@/shared/lib/tokens";

type Kind = Classification["kind"];

// ----- Query classifier (cheap heuristic) -----
// Structural signals only. Each regex feeds a weighted 0–100 difficulty score;
// minCap/tokens derive from it in route().
const CODE_WORDS =
  /\b(code|function|regex|bug|python|javascript|typescript|sql|rust|api|refactor|stack ?(trace|overflow)|error|compile)\b/;
const CODE_STRUCT = /[{};]|=>|\bdef |\bimport /;
const STACK_TRACE = /\bat .+\(.+:\d+:\d+\)|Traceback \(most recent call last\)|\w+(Error|Exception)\b/;
const REASON_WORDS =
  /\b(why|explain|analyze|design|architect|prove|strategy|trade-?off|compare|reason|plan|algorithm|optimi[sz]e)\b/g;
// \b doesn't work on Cyrillic — plain alternatives instead.
const REASON_WORDS_RU = /почему|объясн|анализ|докаж|сравн|оптимизир|алгоритм|спроектир|стратеги/g;
const MATH = /\bO\([^)]*\)|[∑∫√≈≤≥]/;
const CONSTRAINTS = /\b(without using|in-?place|at most|no more than)\b|не использу|за o\(/;

export function scoreDifficulty(text: string): { score: number; isCode: boolean } {
  const raw = text || "";
  const t = raw.toLowerCase();
  let score = 0;

  const isCode = CODE_WORDS.test(t) || CODE_STRUCT.test(raw) || /```/.test(raw) || STACK_TRACE.test(raw);
  if (isCode) score += 25;
  if (/```/.test(raw)) score += 10;
  if (STACK_TRACE.test(raw)) score += 15;

  // More distinct reasoning verbs = harder: 25 for one, +5 each up to 40.
  const reasonHits = (t.match(REASON_WORDS) || []).length + (t.match(REASON_WORDS_RU) || []).length;
  if (reasonHits) score += Math.min(40, 20 + reasonHits * 5);
  if (MATH.test(raw)) score += 10;
  if (CONSTRAINTS.test(t)) score += 10;

  // Multi-step structure: list items + multiple questions.
  const steps = (raw.match(/^\s*(?:[-*]|\d+[.)])\s/gm) || []).length;
  if (steps >= 2) score += Math.min(15, steps * 5);
  if ((raw.match(/\?/g) || []).length >= 2) score += 5;

  // Graded length: 0 below ~16 tokens, +25 at ~300.
  score += Math.min(25, Math.max(0, ((estimateTokens(raw) - 16) / 284) * 25));

  return { score: Math.min(100, Math.round(score)), isCode };
}

export function classify(text: string): Classification {
  const { score, isCode } = scoreDifficulty(text);
  let kind: Kind;
  if (score >= 70) kind = "complex";
  else if (isCode) kind = "code";
  else if (score < 25) kind = "trivial";
  else kind = "general";
  const labels: Record<Kind, string> = {
    trivial: "Simple factual query",
    general: "General request",
    code: "Code-related request",
    complex: "Complex reasoning task",
  };
  return { kind, label: `${labels[kind]} (difficulty ${score}/100)`, difficulty: score };
}

// ----- Routing engine -----
export function route(
  text: string,
  policy: PolicyId,
  opts?: { requireVision?: boolean; contextTokens?: number; pool?: Model[] }
): Decision {
  const cls = classify(text);
  const score = cls.difficulty ?? 0;
  const tokens = Math.round(200 + score * 10);
  // 65→92 over the score range (endpoints = old trivial(68)/complex(90) buckets).
  const minCap = Math.min(92, 65 + score * 0.27);

  // opts.pool = models the connected backends actually serve; absent → demo registry.
  const base = opts?.pool?.length ? opts.pool : MODELS;
  let pool = base.filter((m) => m.cap >= minCap);
  if (policy === "privacy") {
    // Prefer connected local models (e.g. a custom localhost endpoint); demo locals as fallback.
    const locals = base.filter((m) => m.local);
    pool = locals.length ? locals : MODELS.filter((m) => m.local);
  }
  if (pool.length === 0) pool = opts?.pool?.length ? base : MODELS.filter((m) => m.local); // fallback
  // Attached image needs a vision model — overrides policy/privacy. Keep the pool when
  // nothing in the live set has vision (a worse answer beats an empty pool).
  if (opts?.requireVision) {
    const v = pool.filter((m) => m.vision);
    const any = base.filter((m) => m.vision);
    pool = v.length ? v : any.length ? any : pool;
  }
  // Context-pressure floor: drop models whose window can't hold the live conversation + this
  // turn's output. Skipped when it would empty the pool — compaction is the fallback, and this
  // keeps privacy-local models in play even on a long chat.
  const need = (opts?.contextTokens ?? 0) + tokens;
  const fits = pool.filter((m) => ctxTokens(m.ctx) >= need);
  if (fits.length) pool = fits;

  const reqCost = (m: Model) => (m.cost * tokens) / 1000;

  const scored: Candidate[] = pool.map((m) => {
    let score: number;
    if (policy === "cost") score = 100 - reqCost(m) * 4000 + (m.cap - minCap) * 0.15;
    else if (policy === "quality") score = m.cap * 1.0 + m.spd * 0.05;
    else if (policy === "speed") score = m.spd * 1.0 + m.cap * 0.08 - m.latency * 6;
    else score = m.cap * 1.0 - reqCost(m) * 1000; // privacy
    return { model: m, score, reqCost: reqCost(m) };
  });
  scored.sort((a, b) => b.score - a.score);

  const chosen = scored[0];
  const alternatives = scored.slice(1, 4);

  const reasonMap: Record<PolicyId, string> = {
    cost: `${cls.label} → routed to the cheapest model that clears the quality bar.`,
    quality: `${cls.label} → escalated to a top-tier model for maximum output quality.`,
    speed: `${cls.label} → sent to the lowest-latency model available.`,
    privacy: `${cls.label} → kept on-device; no data left your machine.`,
  };

  const baseline = (MODEL_BY_ID["gpt-4o"].cost * tokens) / 1000;
  const saved = Math.max(0, baseline - chosen.reqCost);

  return {
    classification: cls,
    policy,
    tokens,
    chosen: chosen.model,
    chosenCost: chosen.reqCost,
    candidates: scored.map((s) => ({ model: s.model, reqCost: s.reqCost, score: s.score })),
    alternatives: alternatives.map((s) => ({ model: s.model, reqCost: s.reqCost })),
    reason: reasonMap[policy],
    baselineCost: baseline,
    saved,
    latency: chosen.model.latency,
  };
}
