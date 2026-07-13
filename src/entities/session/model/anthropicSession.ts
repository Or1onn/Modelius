// anthropicSession.ts — stored Claude OAuth: access + refresh tokens in the OS keychain
// (separate entries to stay under the Windows Credential Manager blob limit), non-secret
// presence meta (expiresAt/hasRefresh) in localStorage so connection checks stay sync.
// Login flow lives in features/connect-anthropic.
import { invoke } from "@tauri-apps/api/core";
import { clearModelCache } from "@/shared/lib/modelCache";
import { secretGet, secretSet, secretDelete } from "@/shared/api/secrets";
import { readOAuthMeta, oauthPresent, oauthExpiringSoon, classifyRefreshError, type OAuthPresenceMeta, type RefreshFailure } from "@/entities/session/model/oauthShared";

// Public OAuth client (Claude Code / `claude setup-token`) — shared with the connect feature.
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTH_URL = "https://claude.ai/oauth/authorize";
export const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const SCOPES = "org:create_api_key user:profile user:inference";

const ACCESS_KEY = "modelius.anthropic.access";
const REFRESH_KEY = "modelius.anthropic.refresh";
const META_KEY = "modelius.oauthmeta.anthropic"; // localStorage: non-secret presence
export const ANTHROPIC_OAUTH_EVT = "modelius-anthropic-oauth-changed";

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

const readMeta = () => readOAuthMeta<OAuthPresenceMeta>(META_KEY);

async function read(): Promise<OAuthToken | null> {
  const accessToken = await secretGet(ACCESS_KEY);
  if (!accessToken) return null;
  const refreshToken = (await secretGet(REFRESH_KEY)) ?? undefined;
  return { accessToken, refreshToken, expiresAt: readMeta()?.expiresAt };
}

async function write(token: OAuthToken | null): Promise<void> {
  if (token) {
    await secretSet(ACCESS_KEY, token.accessToken);
    if (token.refreshToken) await secretSet(REFRESH_KEY, token.refreshToken);
    else await secretDelete(REFRESH_KEY);
    try {
      localStorage.setItem(META_KEY, JSON.stringify({ expiresAt: token.expiresAt, hasRefresh: !!token.refreshToken }));
    } catch {
      /* ignore */
    }
  } else {
    await secretDelete(ACCESS_KEY);
    await secretDelete(REFRESH_KEY);
    try {
      localStorage.removeItem(META_KEY);
    } catch {
      /* ignore */
    }
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

// Persist a freshly exchanged token (connect flow, post-login).
export async function saveAnthropicToken(data: TokenResponse): Promise<void> {
  await write(fromResponse(data));
}

// Sync presence from non-secret meta: usable if it has a refresh token or isn't expired.
export function hasAnthropicOAuth(): boolean {
  return oauthPresent(readMeta());
}

export async function disconnectAnthropicOAuth(): Promise<void> {
  await write(null);
  clearModelCache();
}

type RefreshResult = { ok: OAuthToken } | { fail: RefreshFailure };

// Single-flight the refresh: refresh tokens rotate (the old one is invalidated once the grant
// succeeds), so two concurrent callers racing the same token would make the loser get
// invalid_grant. Sharing one in-flight promise prevents that rotation race.
let refreshing: Promise<RefreshResult> | null = null;

async function refresh(token: OAuthToken): Promise<RefreshResult> {
  if (!token.refreshToken) return { fail: "auth_failed" };
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const data = await invoke<TokenResponse>("anthropic_oauth_token", {
        body: { grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: CLIENT_ID },
      });
      const next = fromResponse(data, token.refreshToken);
      await write(next);
      return { ok: next } as RefreshResult;
    } catch (e) {
      return { fail: classifyRefreshError(e instanceof Error ? e.message : String(e)) } as RefreshResult;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Usable access token, refreshing first if near-expiry.
export async function getAnthropicAccessToken(): Promise<string | null> {
  const token = await read();
  if (!token) return null;
  if (oauthExpiringSoon(token.expiresAt)) {
    const r = await refresh(token);
    if ("ok" in r) return r.ok.accessToken;
    if (r.fail === "auth_failed") await write(null); // token truly dead → drop, UI flips to disconnected
    return null; // transient → keep the stored tokens; just fail this call
  }
  return token.accessToken;
}

// A 401 on a stream can be a transient/rotation-race blip, not a revoked session. Try a refresh;
// only drop the login if the refresh is definitively rejected (auth_failed / no refresh token).
export async function handleAnthropicUnauthorized(): Promise<void> {
  const token = await read();
  if (!token) return;
  const r = await refresh(token);
  if ("fail" in r && r.fail === "auth_failed") await write(null);
}
