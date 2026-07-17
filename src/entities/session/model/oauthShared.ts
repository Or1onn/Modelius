// oauthShared.ts — pieces identical across the Anthropic and OpenAI OAuth stores: the
// non-secret localStorage presence meta and the expiry rules. Keeping them here means the
// "is this account usable / does it need a refresh" logic can't drift between providers.

export interface OAuthPresenceMeta {
  expiresAt?: number; // epoch ms
  hasRefresh: boolean;
}

export function readOAuthMeta<T extends OAuthPresenceMeta>(metaKey: string): T | null {
  try {
    const raw = localStorage.getItem(metaKey);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// Sync presence check: usable if it has a refresh token or isn't expired.
export function oauthPresent(meta: OAuthPresenceMeta | null): boolean {
  if (!meta) return false;
  if (meta.hasRefresh) return true;
  if (meta.expiresAt === undefined) return true;
  return Date.now() < meta.expiresAt;
}

// Within a minute of expiry → refresh before use.
export const oauthExpiringSoon = (expiresAt?: number): boolean =>
  expiresAt !== undefined && Date.now() + 60_000 >= expiresAt;

// A refresh grant either fails because the token is genuinely dead (drop the login) or for a
// transient reason (network/429/5xx) that must NOT wipe the stored tokens.
export type RefreshFailure = "auth_failed" | "transient";

// Classify a refresh error message. Rust `json_or_err` formats HTTP failures as
// "<label> <status>: <body>" and transport failures as a bare error string. Only a definitive
// OAuth rejection (invalid_grant, or a 400/401/403) means the token is dead; everything else —
// no status (network), 429, 5xx — is transient and keeps the stored login intact.
export function classifyRefreshError(msg: string): RefreshFailure {
  if (/invalid_grant/i.test(msg)) return "auth_failed";
  const m = msg.match(/\b(\d{3})\b/);
  if (m) {
    const code = Number(m[1]);
    if (code === 400 || code === 401 || code === 403) return "auth_failed";
  }
  return "transient";
}

// ---- shared refresh machinery over a provider's token store ----

interface RefreshableToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

export interface OAuthStore<T extends RefreshableToken> {
  read(): Promise<T | null>;
  write(token: T | null): Promise<void>;
  // The provider's refresh grant: exchange the rotating refresh token for a fresh token set.
  // Throws on failure; the message is classified by classifyRefreshError.
  refreshGrant(token: T): Promise<T>;
}

export type RefreshResult<T> = { ok: T } | { fail: RefreshFailure };

// Single-flight refresh + expiry-gated access + 401 handling, identical across providers.
// Refresh tokens rotate (the old one is invalidated once the grant succeeds), so two concurrent
// callers racing the same token would make the loser get invalid_grant — sharing one in-flight
// promise prevents that rotation race.
export function createOAuthRefresher<T extends RefreshableToken>(store: OAuthStore<T>) {
  let refreshing: Promise<RefreshResult<T>> | null = null;

  async function refresh(token: T): Promise<RefreshResult<T>> {
    if (!token.refreshToken) return { fail: "auth_failed" };
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const next = await store.refreshGrant(token);
        await store.write(next);
        return { ok: next } as RefreshResult<T>;
      } catch (e) {
        return { fail: classifyRefreshError(e instanceof Error ? e.message : String(e)) } as RefreshResult<T>;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // Usable token, refreshing first if near-expiry. auth_failed drops the login (UI flips to
  // disconnected); a transient failure keeps the stored tokens and just fails this call.
  async function getFresh(): Promise<T | null> {
    const token = await store.read();
    if (!token) return null;
    if (oauthExpiringSoon(token.expiresAt)) {
      const r = await refresh(token);
      if ("ok" in r) return r.ok;
      if (r.fail === "auth_failed") await store.write(null);
      return null;
    }
    return token;
  }

  // A 401 on a stream can be a transient/rotation-race blip, not a revoked session. Try a
  // refresh; only drop the login if the refresh is definitively rejected.
  async function handleUnauthorized(): Promise<void> {
    const token = await store.read();
    if (!token) return;
    const r = await refresh(token);
    if ("fail" in r && r.fail === "auth_failed") await store.write(null);
  }

  return { refresh, getFresh, handleUnauthorized };
}
