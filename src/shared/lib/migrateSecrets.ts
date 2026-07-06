// migrateSecrets.ts — one-time, idempotent move of plaintext secrets from localStorage
// into the OS keychain (Tauri only). Runs at startup before anything reads a secret. Data
// (chats/memory/artifacts) isn't migrated here — it re-encrypts lazily on next write via
// the vault's tolerant decrypt. Key names mirror the session/key modules (kept inline to
// avoid an entities→shared import).
import { isTauri } from "@/shared/api/tauri";
import { secretGet, secretSet } from "@/shared/api/secrets";

const MIGRATED = "modelius.migrated.v1";
const PROVIDERS = ["openai", "anthropic", "google", "groq"];

export async function migrateToSecureStorage(): Promise<void> {
  // Browser/dev keeps secrets in the localStorage fallback already — nothing to move.
  if (!isTauri()) return;
  try {
    if (localStorage.getItem(MIGRATED)) return;

    // API keys → keychain + non-secret last-6 meta.
    for (const p of PROVIDERS) {
      const old = localStorage.getItem("modelius.key." + p);
      if (old && !(await secretGet("modelius.key." + p))) {
        await secretSet("modelius.key." + p, old);
        localStorage.setItem("modelius.keymeta." + p, JSON.stringify({ last6: old.slice(-6) }));
      }
      localStorage.removeItem("modelius.key." + p);
    }

    // OAuth blobs → split access/refresh keychain entries + presence meta.
    await migrateOAuth("anthropic");
    await migrateOAuth("openai");

    // PKCE verifier (transient — only present mid-login).
    const pkce = localStorage.getItem("modelius.anthropic.pkce");
    if (pkce && !(await secretGet("modelius.anthropic.pkce"))) await secretSet("modelius.anthropic.pkce", pkce);
    localStorage.removeItem("modelius.anthropic.pkce");

    localStorage.setItem(MIGRATED, "1");
    // Nudge any mounted UI to re-read the freshly written presence meta.
    for (const evt of ["modelius-keys-changed", "modelius-anthropic-oauth-changed", "modelius-openai-oauth-changed"])
      window.dispatchEvent(new Event(evt));
  } catch (e) {
    // Partial migration: flag stays unset, so the next launch retries (the "already in
    // keychain" guards keep it idempotent).
    console.warn("[migrate] secure-storage migration incomplete:", e);
  }
}

async function migrateOAuth(provider: "anthropic" | "openai"): Promise<void> {
  const raw = localStorage.getItem(`modelius.${provider}.oauth`);
  if (raw) {
    try {
      const t = JSON.parse(raw) as { accessToken?: string; refreshToken?: string; expiresAt?: number; accountId?: string };
      if (t.accessToken && !(await secretGet(`modelius.${provider}.access`))) {
        await secretSet(`modelius.${provider}.access`, t.accessToken);
        if (t.refreshToken) await secretSet(`modelius.${provider}.refresh`, t.refreshToken);
        const meta =
          provider === "openai"
            ? { expiresAt: t.expiresAt, accountId: t.accountId ?? "", hasRefresh: !!t.refreshToken }
            : { expiresAt: t.expiresAt, hasRefresh: !!t.refreshToken };
        localStorage.setItem(`modelius.oauthmeta.${provider}`, JSON.stringify(meta));
      }
    } catch {
      /* malformed blob — drop it */
    }
  }
  localStorage.removeItem(`modelius.${provider}.oauth`);
}
