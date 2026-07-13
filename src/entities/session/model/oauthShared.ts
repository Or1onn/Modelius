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
