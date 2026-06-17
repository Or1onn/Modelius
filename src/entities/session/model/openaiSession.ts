// openaiSession.ts — stored ChatGPT (Codex) OAuth: access + refresh tokens in the OS
// keychain (separate entries to stay under the Windows Credential Manager blob limit),
// non-secret presence meta (expiresAt/accountId/hasRefresh) in localStorage so connection
// checks stay sync. Login flow lives in features/connect-openai.
import { invoke } from "@tauri-apps/api/core";
import { clearModelCache } from "@/shared/lib/modelCache";
import { secretGet, secretSet, secretDelete } from "@/shared/api/secrets";

// OAuth client/flow constants — shared with the connect feature.
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPES = "openid profile email offline_access";

const ACCESS_KEY = "orchestro.openai.access";
const REFRESH_KEY = "orchestro.openai.refresh";
const META_KEY = "orchestro.oauthmeta.openai"; // localStorage: non-secret presence + accountId
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

interface OAuthMeta {
  expiresAt?: number;
  accountId: string;
  hasRefresh: boolean;
}

function readMeta(): OAuthMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as OAuthMeta) : null;
  } catch {
    return null;
  }
}

async function read(): Promise<OpenAIToken | null> {
  const accessToken = await secretGet(ACCESS_KEY);
  if (!accessToken) return null;
  const refreshToken = (await secretGet(REFRESH_KEY)) ?? undefined;
  const meta = readMeta();
  return { accessToken, refreshToken, accountId: meta?.accountId ?? "", expiresAt: meta?.expiresAt };
}

async function write(token: OpenAIToken | null): Promise<void> {
  if (token) {
    await secretSet(ACCESS_KEY, token.accessToken);
    if (token.refreshToken) await secretSet(REFRESH_KEY, token.refreshToken);
    else await secretDelete(REFRESH_KEY);
    try {
      localStorage.setItem(
        META_KEY,
        JSON.stringify({ expiresAt: token.expiresAt, accountId: token.accountId, hasRefresh: !!token.refreshToken })
      );
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
  window.dispatchEvent(new Event(OPENAI_OAUTH_EVT));
}

// ChatGPT account id from the id_token JWT claims.
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

// Persist a freshly exchanged token (connect flow, post-login).
export async function saveOpenAIToken(data: TokenResponse): Promise<void> {
  await write(fromResponse(data));
}

// Sync presence from non-secret meta: usable if it has a refresh token or isn't expired.
export function hasOpenAIOAuth(): boolean {
  const meta = readMeta();
  if (!meta) return false;
  if (meta.hasRefresh) return true;
  if (meta.expiresAt === undefined) return true;
  return Date.now() < meta.expiresAt;
}

export async function disconnectOpenAIOAuth(): Promise<void> {
  await write(null);
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
    await write(next);
    return next;
  } catch {
    return null;
  }
}

// Usable access token + account id, refreshing first if near-expiry.
export async function getOpenAIAuth(): Promise<{ token: string; accountId: string } | null> {
  const token = await read();
  if (!token) return null;
  const expiringSoon = token.expiresAt !== undefined && Date.now() + 60_000 >= token.expiresAt;
  if (expiringSoon) {
    const refreshed = await refresh(token);
    if (!refreshed) {
      await write(null); // refresh failed → drop so UI flips to disconnected
      return null;
    }
    return { token: refreshed.accessToken, accountId: refreshed.accountId };
  }
  return { token: token.accessToken, accountId: token.accountId };
}
