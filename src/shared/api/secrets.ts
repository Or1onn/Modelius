// secrets.ts — secure-storage chokepoint. Secrets live in the OS keychain; values too big
// for the keychain (the Windows Credential Manager caps a blob at ~2.5 KB and a ChatGPT
// access-token JWT exceeds it) overflow to a vault-encrypted localStorage entry — still
// confidential, since the ciphertext needs the keychain-held DEK. Read tries the keychain
// then the overflow, so set/get stay symmetric. Browser/dev (no Tauri) keeps plaintext.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";

const LS = "modelius.secret."; // localStorage namespace for the keychain overflow
let warned = false;
function degrade(e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("[secrets] keychain rejected a value (size/availability) — using encrypted localStorage overflow:", e);
}

// Thrown by vaultDecrypt when the Rust decrypt fails (keychain/DEK unavailable, or a genuine
// crypto failure). Callers use it to tell "couldn't decrypt right now" (transient — must not be
// treated as empty/corrupt data) from legacy plaintext (which the Rust decrypt returns as Ok).
export class VaultUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("vault unavailable");
    this.name = "VaultUnavailableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
export const isVaultUnavailable = (e: unknown): e is VaultUnavailableError => e instanceof VaultUnavailableError;

export async function secretGet(key: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const v = await invoke<string | null>("secret_get", { key });
      if (v !== null) return v;
    } catch (e) {
      degrade(e);
    }
  }
  // Keychain miss/unavailable → overflow blob (vault-encrypted under Tauri; the tolerant
  // decrypt also reads back legacy/dev plaintext, so a value written before this fix loads).
  const blob = localStorage.getItem(LS + key);
  if (blob === null) return null;
  if (!isTauri()) return blob;
  try {
    return await vaultDecrypt(blob);
  } catch {
    // Vault temporarily unavailable — treat as "can't read right now" rather than exposing
    // ciphertext or deleting anything. The secret is untouched; a later read recovers it.
    return null;
  }
}

// Store a secret. Returns true if the value was persisted somewhere durable. Never deletes an
// existing value before a replacement is confirmed written, so a transient keychain error can't
// lose it.
export async function secretSet(key: string, value: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await invoke("secret_set", { key, value });
      localStorage.removeItem(LS + key); // clear any stale overflow now that it fits
      return true;
    } catch (e) {
      degrade(e); // e.g. value exceeds the Credential Manager blob limit → overflow below
      // Write the overflow FIRST; only once it's safely stored do we clear the (now-stale)
      // keychain entry. If the overflow write fails too, leave the keychain entry intact.
      try {
        localStorage.setItem(LS + key, await vaultEncrypt(value));
      } catch {
        return false; // couldn't store anywhere — don't touch the existing keychain entry
      }
      try {
        await invoke("secret_delete", { key }); // stale keychain entry mustn't shadow the overflow
      } catch {
        /* ignore — the overflow is now authoritative */
      }
      return true;
    }
  }
  try {
    localStorage.setItem(LS + key, await vaultEncrypt(value));
    return true;
  } catch {
    return false;
  }
}

export async function secretDelete(key: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("secret_delete", { key });
    } catch (e) {
      degrade(e);
    }
  }
  try {
    localStorage.removeItem(LS + key);
  } catch {
    /* ignore */
  }
}

// Encrypt for on-disk storage. Dev/unavailable → identity (the tolerant Rust
// decrypt reads back unprefixed plaintext, so this round-trips).
export async function vaultEncrypt(plain: string): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("vault_encrypt", { plaintext: plain });
    } catch (e) {
      degrade(e);
    }
  }
  return plain;
}

export async function vaultDecrypt(blob: string): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("vault_decrypt", { blob });
    } catch (e) {
      // Throw (don't fall back to the raw ciphertext) so hydrate/load callers can distinguish a
      // transient vault failure from real data and avoid clobbering it with an empty state.
      throw new VaultUnavailableError(e);
    }
  }
  return blob;
}
