// demo.ts — scripted offline answers used when no backend is configured.

// ----- Scripted answers -----
export function answerFor(text: string): string {
  const t = (text || "").toLowerCase();
  if (/regex|email/.test(t))
    return "Here's a pragmatic pattern — strict enough for forms, lenient on valid edge cases:\n\n```js\nconst EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;\nconst ok = EMAIL.test(input.trim());\n```\n\nFor anything mission-critical, send a confirmation link instead of over-engineering the pattern — the only true test of an address is whether mail reaches it.";
  if (/debounce|throttle/.test(t))
    return "A debounce delays a call until activity stops; a throttle caps how often it can fire. For a search box you want debounce:\n\n```js\nconst debounce = (fn, ms = 300) => {\n  let id;\n  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };\n};\n```\n\nReach for throttle on scroll/resize where you want steady updates rather than a single trailing one.";
  if (/index|database|slow query|postgres|sql/.test(t))
    return 'Start with `EXPLAIN ANALYZE` — most "slow query" tickets are a missing index on the filtered or joined column. Add a B-tree index on the high-selectivity predicate first, then re-measure before adding more. Composite indexes only help when the leading column matches your `WHERE`, so order them by selectivity, not by guess.';
  if (/translat|french|spanish/.test(t))
    return "Bonjour — heureux de vous aider. Dites-moi simplement le texte à traduire et le registre souhaité (formel ou familier), et je m'en occupe.";
  if (/capital of|how many|what year|who is|when did/.test(t))
    return "Quick answer: that's a well-established fact, so I routed it to a fast, low-cost tier rather than a frontier model. Ask me anything heavier and the policy will escalate automatically.";
  return "Got it. I've broken this down and routed it under your active policy — the panel on the right shows exactly which model handled it, why, and what it cost versus running everything on GPT-4o. Ask a follow-up and watch the routing adapt to the shape of the question.";
}
