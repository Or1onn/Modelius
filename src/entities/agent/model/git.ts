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
