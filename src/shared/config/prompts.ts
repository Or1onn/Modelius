// prompts.ts — the shared conversation contract: system prompt sent to every
// model, plus the cheap-model instructions for summarization and memory extraction.

// ----- Conversation contract (shared across every model) -----
// One behavioral system prompt for all providers, so tone/personality stay
// consistent when the user switches models mid-chat.
export const SYSTEM_PROMPT =
  "Answer the user directly, clearly and concisely. " +
  "Keep a consistent tone and formatting regardless of the underlying model.";

// Cheap-model instruction used to compress old turns when a chat outgrows the
// window. Keep the facts that the next turn might need.
export const SUMMARY_PROMPT =
  "Summarize the following conversation into a short brief. Preserve facts, " +
  "decisions, names, numbers and any context needed to continue. Be concise.\n" +
  "Code blocks are stored separately as artifacts referenced by tokens like " +
  "[[code-XXXX]]. NEVER reproduce code bodies. Keep a [[code-XXXX]] token in your " +
  "summary ONLY for code still relevant to continue the conversation; omit tokens " +
  "for code that is no longer needed. Preserve the token text exactly.\n\n";

// Cheap "memory" pass: pull durable facts about the USER from the latest turn for
// long-term, cross-session memory. The output is parsed as JSON, so it must be a
// JSON array and nothing else (extra prose breaks the parse → no facts saved).
export const MEMORY_EXTRACT_PROMPT =
  "You maintain a long-term memory of durable facts about the user, to personalize " +
  "future conversations. Read the latest exchange and the facts already known, then " +
  "return ONLY new, lasting facts worth remembering across sessions — name, role, " +
  "stable preferences, recurring projects, persistent context. Ignore one-off questions " +
  "and anything transient, and never repeat a known fact. Write the wording of each fact " +
  "in English, regardless of the conversation's language, so memory stays consistent and " +
  "deduplicates across models — BUT keep names, proper nouns, identifiers, code, paths, and " +
  "quoted text verbatim in their original spelling and script; never translate or " +
  "transliterate them. Reply with a " +
  'JSON array only: [{"text":"<concise fact, third person>","kind":"user|preference|project|fact"}]. ' +
  "Use [] when there is nothing worth saving. No prose, no code fences.\n\n";
