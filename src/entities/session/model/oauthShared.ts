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
