// anthropicSession.ts — stored Claude OAuth session: read/refresh/clear the token
// and report connection state. The login *flow* lives in features/connect-anthropic.
import { invoke } from "@tauri-apps/api/core";
import { clearModelCache } from "@/shared/lib/modelCache";

// Public OAuth client used by Claude Code / `claude setup-token` — shared with the
// connect feature.
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTH_URL = "https://claude.ai/oauth/authorize";
export const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const SCOPES = "org:create_api_key user:profile user:inference";

const TOKEN_KEY = "orchestro.anthropic.oauth";
export const ANTHROPIC_OAUTH_EVT = "orchestro-anthropic-oauth-changed";

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function read(): OAuthToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as OAuthToken) : null;
  } catch {
    return null;
  }
}

function write(token: OAuthToken | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(ANTHROPIC_OAUTH_EVT));
}

function fromResponse(data: TokenResponse, prevRefresh?: string): OAuthToken {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || prevRefresh,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

// Persist a freshly exchanged token — used by the connect flow after login.
export function saveAnthropicToken(data: TokenResponse): void {
  write(fromResponse(data));
}

// A stored token counts as connected only if it's still usable: renewable via a
// refresh token, or not yet past its expiry. An expired token with no refresh is
// a dead session and must read as disconnected.
export function hasAnthropicOAuth(): boolean {
  const token = read();
  if (!token) return false;
  if (token.refreshToken) return true;
  if (token.expiresAt === undefined) return true;
  return Date.now() < token.expiresAt;
}

export function disconnectAnthropicOAuth(): void {
  write(null);
  clearModelCache();
}

async function refresh(token: OAuthToken): Promise<OAuthToken | null> {
  if (!token.refreshToken) return null;
  try {
    const data = await invoke<TokenResponse>("anthropic_oauth_token", {
      body: { grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: CLIENT_ID },
    });
    const next = fromResponse(data, token.refreshToken);
    write(next);
    return next;
  } catch {
    return null;
  }
}

// Returns a usable access token, refreshing first if it's expired/near-expiry.
export async function getAnthropicAccessToken(): Promise<string | null> {
  const token = read();
  if (!token) return null;
  const expiringSoon = token.expiresAt !== undefined && Date.now() + 60_000 >= token.expiresAt;
  if (expiringSoon) {
    const refreshed = await refresh(token);
    if (!refreshed) {
      write(null); // refresh failed → session is dead; drop it so the UI flips to disconnected
      return null;
    }
    return refreshed.accessToken;
  }
  return token.accessToken;
}
