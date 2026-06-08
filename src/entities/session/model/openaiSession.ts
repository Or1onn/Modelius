// openaiSession.ts — stored ChatGPT (Codex) OAuth session: read/refresh/clear the
// token and report connection state. The login *flow* lives in features/connect-openai.
import { invoke } from "@tauri-apps/api/core";
import { clearModelCache } from "@/shared/lib/modelCache";

// OAuth client/flow constants — shared with the connect feature.
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPES = "openid profile email offline_access";

const TOKEN_KEY = "orchestro.openai.oauth";
export const OPENAI_OAUTH_EVT = "orchestro-openai-oauth-changed";

export interface OpenAIToken {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt?: number; // epoch ms
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function read(): OpenAIToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as OpenAIToken) : null;
  } catch {
    return null;
  }
}

function write(token: OpenAIToken | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(OPENAI_OAUTH_EVT));
}

// Pull the ChatGPT account id out of the id_token JWT claims.
function accountIdFromIdToken(idToken?: string): string {
  if (!idToken) return "";
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return json?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? "";
  } catch {
    return "";
  }
}

function fromResponse(data: TokenResponse, prev?: OpenAIToken): OpenAIToken {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || prev?.refreshToken,
    accountId: accountIdFromIdToken(data.id_token) || prev?.accountId || "",
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

// Persist a freshly exchanged token — used by the connect flow after login.
export function saveOpenAIToken(data: TokenResponse): void {
  write(fromResponse(data));
}

// A stored token counts as connected only if it's still usable: renewable via a
// refresh token, or not yet past its expiry. An expired token with no refresh is
// a dead session and must read as disconnected.
export function hasOpenAIOAuth(): boolean {
  const token = read();
  if (!token) return false;
  if (token.refreshToken) return true;
  if (token.expiresAt === undefined) return true;
  return Date.now() < token.expiresAt;
}

export function disconnectOpenAIOAuth(): void {
  write(null);
  clearModelCache();
}

async function refresh(token: OpenAIToken): Promise<OpenAIToken | null> {
  if (!token.refreshToken) return null;
  try {
    const data = await invoke<TokenResponse>("openai_oauth_token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      },
    });
    const next = fromResponse(data, token);
    write(next);
    return next;
  } catch {
    return null;
  }
}

// Returns the usable access token + account id, refreshing first if near-expiry.
export async function getOpenAIAuth(): Promise<{ token: string; accountId: string } | null> {
  let token = read();
  if (!token) return null;
  const expiringSoon = token.expiresAt !== undefined && Date.now() + 60_000 >= token.expiresAt;
  if (expiringSoon) {
    const refreshed = await refresh(token);
    if (!refreshed) {
      write(null); // refresh failed → session is dead; drop it so the UI flips to disconnected
      return null;
    }
    token = refreshed;
  }
  return { token: token.accessToken, accountId: token.accountId };
}
