// harnessStatus.ts — which harness CLIs are installed on this machine, plus one-click install.
// Detection and install live in Rust (installer.rs / node_runtime.rs): `harness_status` resolves
// each spec's bin (managed agents prefix, then PATH); `harness_install` runs
// `npm install -g <pkg>` — with the system npm when its Node is acceptable, else with the app's
// portable Node runtime, downloaded silently on demand (agent runs auto-provision it the same
// way). Module-scope store + useSyncExternalStore, like codeSessionStore.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";
import { HARNESS_BY_ID } from "./harnesses";

export interface HarnessInstall {
  installed?: boolean; // undefined until the first probe (web builds never probe)
  installing: boolean;
  error?: string;
}

const statuses = new Map<string, HarnessInstall>();
const listeners = new Set<() => void>();
let view: Record<string, HarnessInstall> = {};

function commit() {
  view = Object.fromEntries(statuses);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useHarnessStatuses(): Record<string, HarnessInstall> {
  return useSyncExternalStore(subscribe, () => view);
}

// Re-probe every harness bin. Best-effort; keeps in-flight install flags.
export async function refreshHarnessStatuses(): Promise<void> {
  if (!isTauri()) return;
  try {
    const list = await invoke<{ id: string; installed: boolean }[]>("harness_status");
    for (const { id, installed } of list) {
      const prev = statuses.get(id);
      statuses.set(id, {
        installed,
        installing: prev?.installing ?? false,
        error: installed ? undefined : prev?.error,
      });
    }
    commit();
  } catch {
    /* leave whatever we knew */
  }
}

// Whether the CLI's own login is present (file marker or an auth-gated probe command — see
// harness_logged_in). Best-effort; callers should offer a bypass. Web → true (never gate).
// Successes are cached: probes can cost a network round trip per call.
const loggedInCache = new Set<string>();
export async function cliLoggedIn(id: string): Promise<boolean> {
  if (!isTauri()) return true;
  if (loggedInCache.has(id)) return true;
  try {
    const ok = await invoke<boolean>("harness_logged_in", { harness: id });
    if (ok) loggedInCache.add(id);
    return ok;
  } catch {
    return false;
  }
}

// npm install -g the harness's package. Single-flight: concurrent global npm runs contend on the
// same package tree, so only one install at a time.
export async function installHarness(id: string): Promise<void> {
  if (!isTauri()) return;
  if ([...statuses.values()].some((s) => s.installing)) return;
  const prev = statuses.get(id);
  statuses.set(id, { installed: prev?.installed, installing: true, error: undefined });
  commit();
  try {
    const onPath = await invoke<boolean>("harness_install", { harness: id });
    const bin = HARNESS_BY_ID[id]?.bin ?? id;
    statuses.set(id, {
      installed: onPath,
      installing: false,
      error: onPath ? undefined : `Installed, but '${bin}' couldn't be resolved — restart Modelius.`,
    });
  } catch (e) {
    statuses.set(id, { installed: prev?.installed, installing: false, error: String(e) });
  }
  commit();
}
