// branches.ts — sibling-branch navigation (ChatGPT-style ◀ k/n ▶).
// Branches are stored as full thread snapshots; a divergence at position p is where threads
// that share the prefix [0..p) differ at p. Content comparison (role+text) keeps this working
// after a reload, where message objects aren't shared across threads.
import type { Message } from "@/entities/model/model/registry";

export type Thread = Message[];

const eqMsg = (a: Message, b: Message): boolean => a.role === b.role && a.text === b.text;

const eqPrefix = (a: Thread, b: Thread, p: number): boolean => {
  if (a.length < p || b.length < p) return false;
  for (let i = 0; i < p; i++) if (!eqMsg(a[i], b[i])) return false;
  return true;
};

// Distinct version-threads diverging at position p (one representative each, stable order),
// plus the index of the active thread's version. null when there's no real branch at p.
export function branchGroup(
  allThreads: Thread[],
  active: Thread,
  p: number
): { versions: Thread[]; k: number } | null {
  if (p >= active.length) return null;
  const group = allThreads.filter((t) => t.length > p && eqPrefix(t, active, p));
  if (group.length < 2) return null;
  const versions: Thread[] = [];
  for (const t of group) if (!versions.some((v) => eqMsg(v[p], t[p]))) versions.push(t);
  if (versions.length < 2) return null;
  // Order by the diverging message's creation time so k/n stays stable as the user navigates
  // (array order flips when the active thread swaps in/out of the sibling list).
  versions.sort((a, b) => (a[p].ts ?? 0) - (b[p].ts ?? 0));
  const k = versions.findIndex((v) => eqMsg(v[p], active[p]));
  return { versions, k };
}
