// git.ts — thin wrappers over the Rust git_branches / git_checkout commands for Code mode's
// branch picker. On the web (no Tauri) or any failure, listBranches resolves to an empty set so
// the picker simply hides.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";

export interface GitInfo {
  current: string;
  branches: string[];
}

export async function listBranches(cwd: string): Promise<GitInfo> {
  if (!cwd || !isTauri()) return { current: "", branches: [] };
  try {
    return await invoke<GitInfo>("git_branches", { cwd });
  } catch {
    return { current: "", branches: [] };
  }
}

export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("git_checkout", { cwd, branch });
}

// ---- worktree isolation ----
// A Code chat can run in its own checkout on a fresh branch (created under app-data) instead of
// the user's folder. These wrappers propagate git's error text — the changes panel shows it.

export interface WorktreeInfo {
  path: string; // where the agent actually runs
  branch: string;
  base: string; // the ref it was branched from
  repo: string; // the main working tree
}

export interface WorktreeStatus {
  files: { status: string; path: string }[];
  ahead: number;
  diff: string;
  truncated: boolean;
}

// `name` is free text (the chat's first prompt) — the Rust side derives the branch name from it.
export async function createWorktree(cwd: string, base: string, name: string): Promise<WorktreeInfo> {
  return await invoke<WorktreeInfo>("git_worktree_create", { cwd, base, name });
}

export async function worktreeStatus(path: string, base: string): Promise<WorktreeStatus> {
  return await invoke<WorktreeStatus>("git_worktree_status", { path, base });
}

export async function commitWorktree(path: string, message: string): Promise<void> {
  await invoke("git_worktree_commit", { path, message });
}

export async function mergeWorktree(repo: string, base: string, branch: string): Promise<void> {
  await invoke("git_worktree_merge", { repo, base, branch });
}

export async function removeWorktree(wt: WorktreeInfo, deleteBranch: boolean): Promise<void> {
  await invoke("git_worktree_remove", { repo: wt.repo, path: wt.path, branch: wt.branch, deleteBranch });
}
