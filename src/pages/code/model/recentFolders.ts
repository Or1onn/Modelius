// recentFolders.ts — the Code header's folder Picker offers recently-opened workspaces.
// Persisted as a small localStorage list (most-recent first, capped), fed by the native dialog.
const KEY = "modelius.code.recentFolders";
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

// Last-used git branch per folder — so reopening a workspace restores the branch it was left on.
const BRANCH_KEY = "modelius.code.folderBranch";

function branchMap(): Record<string, string> {
  try {
    const m = JSON.parse(localStorage.getItem(BRANCH_KEY) || "{}");
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

export function getFolderBranch(dir: string): string {
  return (dir && branchMap()[dir]) || "";
}

export function setFolderBranch(dir: string, branch: string): void {
  if (!dir || !branch) return;
  const next = { ...branchMap(), [dir]: branch };
  try {
    localStorage.setItem(BRANCH_KEY, JSON.stringify(next));
  } catch {
    /* quota — ignore */
  }
}
