// promptSuggestion.ts — the claude CLI's predicted next user prompt, per chat. The CLI generates it
// itself: `--prompt-suggestions` makes it emit a `prompt_suggestion` stream-json message after each
// turn ({type, suggestion, uuid, session_id}), so the app spends no model call of its own. Only the
// claude harness has this — codex's app-server protocol and kimi's ACP carry no equivalent, so those
// chats simply never get a suggestion.
// Ephemeral like turnStatus.ts: it belongs to the live chat, not the transcript, and the next turn
// invalidates it. Module-scope store + subscribe.
const suggestions = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function notify(chatId: string): void {
  listeners.get(chatId)?.forEach((fn) => fn());
}

// The pending suggestion ("" = none). Reactive via subscribePromptSuggestion.
export function getPromptSuggestion(chatId: string): string {
  return suggestions.get(chatId) ?? "";
}

export function subscribePromptSuggestion(chatId: string, cb: () => void): () => void {
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
  }
  set.add(cb);
  return () => {
    listeners.get(chatId)?.delete(cb);
  };
}

// Store a suggestion, or clear it with "". No-op when unchanged, so a re-send of the same text
// can't re-render the composer.
export function setPromptSuggestion(chatId: string, text: string): void {
  const next = text.trim();
  if (getPromptSuggestion(chatId) === next) return;
  if (next) suggestions.set(chatId, next);
  else suggestions.delete(chatId);
  notify(chatId);
}
