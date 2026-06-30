// updater.ts — app self-update via tauri-plugin-updater. Checks the GitHub
// Releases manifest, then downloads/installs the signed bundle and relaunches.
// No-op (returns null) outside the Tauri shell.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "@/shared/api/tauri";

// The Update handle from check() is reused by installAndRelaunch().
let pending: Update | null = null;

export async function checkForUpdate(): Promise<{ version: string } | null> {
  if (!isTauri()) return null;
  try {
    const update = await check();
    if (update) {
      pending = update;
      return { version: update.version };
    }
  } catch {
    // offline / no manifest / verify failure → treat as "no update", never block UI
  }
  return null;
}

export type UpdateProgress = { downloaded: number; total: number | null };

export async function installAndRelaunch(onProgress?: (p: UpdateProgress) => void): Promise<void> {
  if (!pending) return;
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength ?? null;
    else if (event.event === "Progress") downloaded += event.data.chunkLength;
    onProgress?.({ downloaded, total });
  });
  await relaunch();
}
