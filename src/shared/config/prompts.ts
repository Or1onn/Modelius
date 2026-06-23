// prompts.ts — shared system prompt + cheap-model prompts for summary/memory/title.

// ----- Conversation contract (shared across every model) -----
// One behavioral prompt for all providers, so tone stays consistent across mid-chat switches.
export const SYSTEM_PROMPT =
  "Answer the user directly, clearly and concisely. " +
  "Keep a consistent tone and formatting regardless of the underlying model.";

// Compress old turns when a chat outgrows the window; keep facts the next turn needs.
export const SUMMARY_PROMPT =
  "Summarize the following conversation into a short brief. Preserve facts, " +
  "decisions, names, numbers and any context needed to continue. Be concise.\n" +
  "Code blocks are stored separately as artifacts referenced by tokens like " +
  "[[code-XXXX]]. NEVER reproduce code bodies. Keep a [[code-XXXX]] token in your " +
  "summary ONLY for code still relevant to continue the conversation; omit tokens " +
  "for code that is no longer needed. Preserve the token text exactly.\n\n";

// Reconcile long-term memory against the latest turn: the model returns add/update/delete
// operations referencing known facts by #ref. Output is JSON-parsed: must be a JSON array only.
export const MEMORY_EXTRACT_PROMPT =
  "You maintain a long-term memory of durable facts about the user, to personalize " +
  "future conversations. You are given the facts already known (each tagged with a #ref) " +
  "and the latest exchange. Return a JSON array of operations that reconciles memory with " +
  "what the exchange reveals:\n" +
  '- {"op":"add","text":"<concise fact, third person>","kind":"user|preference|project|fact"} — a NEW durable fact not already covered.\n' +
  '- {"op":"update","ref":<N>,"text":"<sharper/corrected fact>","kind":"..."} — when the exchange refines, corrects, or supersedes known fact #N. Use this INSTEAD of add when the new info concerns the same thing as an existing fact (even if reworded).\n' +
  '- {"op":"delete","ref":<N>} — when known fact #N is now wrong or obsolete.\n' +
  "Only durable facts: name, role, stable preferences, recurring projects, persistent " +
  "context. Ignore one-off questions and anything transient. NEVER add a fact that is " +
  "essentially already known — omit it, or update its #ref. Prefer the fewest operations. " +
  "Write fact text in English regardless of the conversation's language, so memory stays " +
  "consistent across models — BUT keep names, proper nouns, identifiers, code, paths, and " +
  "quoted text verbatim in their original spelling and script; never translate or " +
  "transliterate them. Reply with a JSON array only; use [] when nothing changes. " +
  "No prose, no code fences.\n\n";

// Classify a request for smart routing when the heuristic is unsure. Output is JSON-parsed:
// must be a single JSON object only. Judge SKILL needed, not text length.
export const ROUTE_CLASSIFY_PROMPT =
  "You are a routing classifier. Decide how much model capability the user's request " +
  "truly needs — by the REASONING and SKILL required, NOT by how long the text is. A long " +
  "pasted log, transcript or code dump with a simple ask (find a line, fix a typo, extract " +
  "a value) is LOW difficulty. Categories: trivial = lookup or trivial edit; general = an " +
  "ordinary request; code = a real programming task; complex = multi-step reasoning, " +
  "architecture, math or proof. Reply with a single JSON object only, no prose, no code " +
  'fences: {"difficulty": <integer 0-100>, "kind": "trivial|general|code|complex"}.\n\n';

// Name a new chat from its first exchange. Output used verbatim as the title:
// title text only (no quotes, fences, or trailing punctuation).
export const TITLE_PROMPT =
  "Write a short, descriptive title for this conversation, like a chat app sidebar " +
  "entry that summarizes what it's about. Use 3–6 words in Title Case. Use the same " +
  "language as the user. No quotes, no surrounding punctuation, no emoji. " +
  "Reply with the title only.\n\n";
