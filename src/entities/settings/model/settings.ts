// settings.ts — reactive app-settings store: routing policy + global custom instructions.
// Persisted as a vault-encrypted localStorage blob (user content); an in-RAM cache keeps reads
// synchronous for the UI and the prompt builder. Mirrors the memory.ts store recipe.
import { useEffect, useReducer } from "react";
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";
import type { PolicyId } from "@/entities/model/model/registry";

const STORAGE_KEY = "orchestro.settings";
const EVT = "orchestro-settings-changed";

export type ThemeId = "dark" | "light";

export interface Settings {
  policy: PolicyId;
  customInstructions: string; // appended to the system prompt for every chat
  zoom: number; // UI scale applied via .app { zoom } — clamped to [ZOOM_MIN, ZOOM_MAX]
  theme: ThemeId; // applied via data-theme on <html>
}

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.4;
export const ZOOM_DEFAULT = 1.07;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

const DEFAULTS: Settings = { policy: "cost", customInstructions: "", zoom: ZOOM_DEFAULT, theme: "dark" };
const VALID_POLICIES = new Set<PolicyId>(["cost", "quality", "speed", "privacy"]);
const VALID_THEMES = new Set<ThemeId>(["dark", "light"]);

let cache: Settings = { ...DEFAULTS };
let hydrated = false;
let hydrating: Promise<void> | null = null;

// Decrypt + load settings into RAM once. Idempotent. Tolerant of legacy/partial blobs.
export function hydrateSettings(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydrating)
    hydrating = (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const o = JSON.parse(await vaultDecrypt(raw));
          if (o && typeof o === "object") {
            if (VALID_POLICIES.has(o.policy)) cache.policy = o.policy;
            if (typeof o.customInstructions === "string") cache.customInstructions = o.customInstructions;
            if (typeof o.zoom === "number" && Number.isFinite(o.zoom)) cache.zoom = clampZoom(o.zoom);
            if (VALID_THEMES.has(o.theme)) cache.theme = o.theme;
          }
        }
      } catch {
        /* keep defaults */
      }
      hydrated = true;
      window.dispatchEvent(new Event(EVT));
    })();
  return hydrating;
}

function save(next: Settings): void {
  cache = next;
  window.dispatchEvent(new Event(EVT));
  void (async () => {
    try {
      localStorage.setItem(STORAGE_KEY, await vaultEncrypt(JSON.stringify(next)));
    } catch {
      /* ignore */
    }
  })();
}

export function getSettings(): Settings {
  return { ...cache };
}

export function getPolicy(): PolicyId {
  return cache.policy;
}

export function setPolicy(policy: PolicyId): void {
  if (policy === cache.policy) return;
  save({ ...cache, policy });
}

export function getZoom(): number {
  return cache.zoom;
}

export function setZoom(zoom: number): void {
  const z = clampZoom(zoom);
  if (z === cache.zoom) return;
  save({ ...cache, zoom: z });
}

export function getTheme(): ThemeId {
  return cache.theme;
}

export function setTheme(theme: ThemeId): void {
  if (theme === cache.theme) return;
  save({ ...cache, theme });
}

// Synchronous getter for the prompt builder (mirrors memoryBlock()).
export function getCustomInstructions(): string {
  return cache.customInstructions;
}

export function setCustomInstructions(text: string): void {
  if (text === cache.customInstructions) return;
  save({ ...cache, customInstructions: text });
}

// Subscribe to settings changes (same-tab: custom event; cross-tab: storage).
export function useSettings(): Settings {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const h = () => force();
    window.addEventListener(EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return getSettings();
}
