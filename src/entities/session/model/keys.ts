// keys.ts — API keys: the secret value lives in the OS keychain; a non-secret last-6
// fingerprint is mirrored in localStorage so presence/identity checks stay synchronous
// for the UI and the router. The key value itself is fetched async only when needed.
import { useEffect, useReducer } from "react";
import { clearModelCache } from "@/shared/lib/modelCache";
import { secretGet, secretSet, secretDelete } from "@/shared/api/secrets";

const KEY = "orchestro.key."; // keychain entry name
const META = "orchestro.keymeta."; // localStorage: { last6 } — non-secret
const EVT = "orchestro-keys-changed";

function envKey(provider: string): string {
  if (provider === "openai") return import.meta.env.VITE_OPENAI_API_KEY || "";
  if (provider === "anthropic") return import.meta.env.VITE_ANTHROPIC_API_KEY || "";
  return "";
}

interface KeyMeta {
  last6: string;
}

function readMeta(provider: string): KeyMeta | null {
  try {
    const raw = localStorage.getItem(META + provider);
    return raw ? (JSON.parse(raw) as KeyMeta) : null;
  } catch {
    return null;
  }
}

function writeMeta(provider: string, meta: KeyMeta | null): void {
  try {
    if (meta) localStorage.setItem(META + provider, JSON.stringify(meta));
    else localStorage.removeItem(META + provider);
  } catch {
    /* ignore */
  }
}

// Async: the real key from the keychain, env as a seed fallback.
export async function getKey(provider: string): Promise<string> {
  const stored = await secretGet(KEY + provider);
  return stored ?? envKey(provider);
}

// Sync presence — backed by non-secret meta (or an env seed). Safe in render/router.
export function hasKey(provider: string): boolean {
  return readMeta(provider) !== null || envKey(provider).length > 0;
}

// Sync last-6 fingerprint for cache keys + masked display (no secret exposed).
export function keyLast6(provider: string): string | null {
  const m = readMeta(provider);
  if (m) return m.last6;
  const env = envKey(provider);
  return env ? env.slice(-6) : null;
}

export async function setKey(provider: string, key: string): Promise<void> {
  const k = key.trim();
  await secretSet(KEY + provider, k);
  writeMeta(provider, { last6: k.slice(-6) });
  clearModelCache();
  window.dispatchEvent(new Event(EVT));
}

export async function clearKey(provider: string): Promise<void> {
  await secretDelete(KEY + provider);
  writeMeta(provider, null);
  clearModelCache();
  window.dispatchEvent(new Event(EVT));
}

// Identify a provider from the key's signature (prefix). null = unrecognized.
// Order matters: sk-ant- is a stricter prefix than sk-.
export function detectProvider(key: string): string | null {
  const k = key.trim();
  if (/^sk-ant-/.test(k)) return "anthropic";
  if (/^sk-or-/.test(k)) return "openrouter";
  if (/^sk-/.test(k)) return "openai";
  if (/^AIza/.test(k)) return "google";
  if (/^gsk_/.test(k)) return "groq";
  return null;
}

// Format check only — catches paste mistakes, not validity.
export function validateKey(provider: string, key: string): boolean {
  const k = key.trim();
  if (provider === "openai") return /^sk-/.test(k) && k.length >= 20;
  if (provider === "anthropic") return /^sk-ant-/.test(k) && k.length >= 20;
  if (provider === "openrouter") return /^sk-or-/.test(k) && k.length >= 20;
  return k.length >= 8;
}

export function keyHint(provider: string): string {
  if (provider === "openai") return "Starts with sk- · platform.openai.com/api-keys";
  if (provider === "anthropic") return "Starts with sk-ant- · console.anthropic.com";
  if (provider === "openrouter") return "Starts with sk-or- · openrouter.ai/keys";
  return "Paste your provider API key";
}

export function maskKey(k: string): string {
  if (k.length <= 12) return "••••••••";
  return k.slice(0, 6) + "••••••••" + k.slice(-4);
}

// Subscribe to key changes (same-tab: custom event; cross-tab: storage).
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
