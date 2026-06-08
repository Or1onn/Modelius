// route.ts — the classifier + scoring engine: pick the best model for a prompt
// under the active policy. Pure and deterministic (no network).
import {
  MODELS,
  MODEL_BY_ID,
  type Model,
  type PolicyId,
  type Classification,
  type Candidate,
  type Decision,
} from "@/entities/model/model/registry";

type Kind = Classification["kind"];

// ----- Query classifier (cheap heuristic, deterministic) -----
export function classify(text: string): Classification {
  const t = (text || "").toLowerCase();
  const len = t.length;
  const isCode =
    /\b(code|function|regex|bug|python|javascript|typescript|sql|rust|api|refactor|stack trace|error|compile)\b/.test(t) ||
    /[{};]|=>|def |import /.test(t);
  const isReasoning =
    /\b(why|explain|analyze|design|architect|prove|strategy|trade-?off|compare|reason|plan|algorithm|optimi[sz]e)\b/.test(t) ||
    len > 240;
  const isTrivial = len < 64 && !isCode && !isReasoning;
  if (isReasoning) return { kind: "complex", label: "Complex reasoning task" };
  if (isCode) return { kind: "code", label: "Code-related request" };
  if (isTrivial) return { kind: "trivial", label: "Simple factual query" };
  return { kind: "general", label: "General request" };
}

const EST_TOKENS: Record<Kind, number> = { trivial: 220, general: 480, code: 760, complex: 1150 };
const MIN_CAP: Record<Kind, number> = { trivial: 68, general: 78, code: 82, complex: 90 };

// ----- Routing engine -----
export function route(text: string, policy: PolicyId, opts?: { requireVision?: boolean }): Decision {
  const cls = classify(text);
  const tokens = EST_TOKENS[cls.kind];
  const minCap = MIN_CAP[cls.kind];

  let pool = MODELS.filter((m) => m.cap >= minCap);
  if (policy === "privacy") pool = MODELS.filter((m) => m.local);
  if (pool.length === 0) pool = MODELS.filter((m) => m.local); // fallback
  // An attached image can only go to a vision model — overrides policy/privacy.
  if (opts?.requireVision) {
    const v = pool.filter((m) => m.vision);
    pool = v.length ? v : MODELS.filter((m) => m.vision);
  }

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
