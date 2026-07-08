// recentFolders.ts — the Code header's folder Picker offers recently-opened workspaces.
// Persisted as a small localStorage list (most-recent first, capped), fed by the native dialog.
const KEY = "orchestro.code.recentFolders";
const MAX = 6;

export function getRecentFolders(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecentFolder(dir: string): void {
  if (!dir) return;
  const next = [dir, ...getRecentFolders().filter((d) => d !== dir)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota — ignore */
  }
}
