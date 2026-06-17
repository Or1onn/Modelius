// secrets.ts — secure-storage chokepoint. Secrets live in the OS keychain; values too big
// for the keychain (the Windows Credential Manager caps a blob at ~2.5 KB and a ChatGPT
// access-token JWT exceeds it) overflow to a vault-encrypted localStorage entry — still
// confidential, since the ciphertext needs the keychain-held DEK. Read tries the keychain
// then the overflow, so set/get stay symmetric. Browser/dev (no Tauri) keeps plaintext.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";

const LS = "orchestro.secret."; // localStorage namespace for the keychain overflow
let warned = false;
function degrade(e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("[secrets] keychain rejected a value (size/availability) — using encrypted localStorage overflow:", e);
}

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
  return isTauri() ? vaultDecrypt(blob) : blob;
}

export async function secretSet(key: string, value: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("secret_set", { key, value });
      localStorage.removeItem(LS + key); // clear any stale overflow now that it fits
      return;
    } catch (e) {
      degrade(e); // e.g. value exceeds the Credential Manager blob limit → overflow below
      try {
        await invoke("secret_delete", { key }); // don't let a stale keychain entry shadow the overflow
      } catch {
        /* ignore */
      }
    }
  }
  try {
    localStorage.setItem(LS + key, await vaultEncrypt(value));
  } catch {
    /* ignore */
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
      degrade(e);
    }
  }
  return blob;
}
