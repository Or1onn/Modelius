// keys.ts — persisted, reactive API-key store (localStorage-backed).
// Keys never leave the device except to the model provider's own API.
import { useEffect, useReducer } from "react";
import { clearModelCache } from "@/shared/lib/modelCache";

const PREFIX = "orchestro.key.";
const EVT = "orchestro-keys-changed";

function envKey(provider: string): string {
  if (provider === "openai") return import.meta.env.VITE_OPENAI_API_KEY || "";
  if (provider === "anthropic") return import.meta.env.VITE_ANTHROPIC_API_KEY || "";
  return "";
}

export function getKey(provider: string): string {
  // A key entered in-app (stored) takes precedence; env is only a seed fallback.
  try {
    const stored = localStorage.getItem(PREFIX + provider);
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  return envKey(provider);
}

export function hasKey(provider: string): boolean {
  return getKey(provider).length > 0;
}

export function setKey(provider: string, key: string): void {
  try {
    localStorage.setItem(PREFIX + provider, key.trim());
  } catch {
    /* ignore */
  }
  clearModelCache();
  window.dispatchEvent(new Event(EVT));
}

export function clearKey(provider: string): void {
  try {
    localStorage.removeItem(PREFIX + provider);
  } catch {
    /* ignore */
  }
  clearModelCache();
  window.dispatchEvent(new Event(EVT));
}

// Lightweight format validation — catches obvious paste mistakes, not validity.
export function validateKey(provider: string, key: string): boolean {
  const k = key.trim();
  if (provider === "openai") return /^sk-/.test(k) && k.length >= 20;
  if (provider === "anthropic") return /^sk-ant-/.test(k) && k.length >= 20;
  return k.length >= 8;
}

export function keyHint(provider: string): string {
  if (provider === "openai") return "Starts with sk- · platform.openai.com/api-keys";
  if (provider === "anthropic") return "Starts with sk-ant- · console.anthropic.com";
  return "Paste your provider API key";
}

export function maskKey(k: string): string {
  if (k.length <= 12) return "••••••••";
  return k.slice(0, 6) + "••••••••" + k.slice(-4);
}

// Subscribe to key changes (same-tab via custom event, other tabs via storage).
export function useKeyStore() {
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
  return { getKey, hasKey, setKey, clearKey, validateKey };
}
