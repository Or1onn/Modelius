// turnStatus.ts — transient per-chat turn telemetry for the Code screen: the CLI's latest stderr
// line (retry/backoff notices) and the time of the last stdout activity (silence detector input).
// Lives outside the transcript on purpose — status is ephemeral and must vanish when the turn
// ends, not persist inside UIMessage parts. Module-scope store + subscribe, like the registry.
export interface TurnStatus {
  note: string | null; // latest stderr line while the turn runs; null when the CLI is quiet
  activityAt: number; // last stdout-line arrival (0 = no turn seen yet)
}

const EMPTY: TurnStatus = { note: null, activityAt: 0 };
const statuses = new Map<string, TurnStatus>();
const listeners = new Map<string, Set<() => void>>();

function notify(chatId: string): void {
  listeners.get(chatId)?.forEach((fn) => fn());
}

export function getTurnStatus(chatId: string): TurnStatus {
  return statuses.get(chatId) ?? EMPTY;
}

export function subscribeTurnStatus(chatId: string, cb: () => void): () => void {
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

// A stderr line from the live run — surface it as the status note.
export function noteTurnStderr(chatId: string, line: string): void {
  const note = line.trim();
  if (!note) return;
  statuses.set(chatId, { ...getTurnStatus(chatId), note });
  notify(chatId);
}

// A stdout line — the turn is alive; fresh output supersedes a stale retry note. Coarse (2s)
// so a token stream doesn't re-render the status row per delta.
export function bumpTurnActivity(chatId: string): void {
  const cur = getTurnStatus(chatId);
  const now = Date.now();
  if (cur.note === null && now - cur.activityAt < 2000) return;
  statuses.set(chatId, { note: null, activityAt: now });
  notify(chatId);
}

export function clearTurnStatus(chatId: string): void {
  if (!statuses.delete(chatId)) return;
  notify(chatId);
}
