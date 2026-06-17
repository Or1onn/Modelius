// anthropicAuth.ts — "Connect Claude account" OAuth (PKCE) login flow.
import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { secretGet, secretSet, secretDelete } from "@/shared/api/secrets";
import {
  CLIENT_ID,
  AUTH_URL,
  REDIRECT_URI,
  SCOPES,
  ANTHROPIC_OAUTH_EVT,
  saveAnthropicToken,
  hasAnthropicOAuth,
  disconnectAnthropicOAuth,
  type TokenResponse,
} from "@/entities/session/model/anthropicSession";

const PKCE_KEY = "orchestro.anthropic.pkce"; // keychain (transient, deleted after exchange)

// ----- PKCE -----
function base64url(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// Open browser; user pastes the code into completeLogin(). PKCE verifier stashed between.
export async function beginAnthropicLogin(): Promise<void> {
  const { verifier, challenge } = await generatePkce();
  await secretSet(PKCE_KEY, verifier);

  const url = new URL(AUTH_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);

  await openUrl(url.toString());
}

// Exchange the pasted "code#state" for tokens.
export async function completeAnthropicLogin(raw: string): Promise<void> {
  const verifier = (await secretGet(PKCE_KEY)) || "";
  if (!verifier) throw new Error("Start the connection first, then paste the code.");

  const [code, state] = raw.trim().split("#");
  if (!code) throw new Error("That doesn't look like an authorization code.");

  const data = await invoke<TokenResponse>("anthropic_oauth_token", {
    body: {
      grant_type: "authorization_code",
      code,
      state: state ?? verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });

  await saveAnthropicToken(data);
  await secretDelete(PKCE_KEY);
}

// Subscribe to connect/disconnect changes (same-tab + cross-tab).
export function useAnthropicAuth() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const h = () => force();
    window.addEventListener(ANTHROPIC_OAUTH_EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(ANTHROPIC_OAUTH_EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return { connected: hasAnthropicOAuth(), beginAnthropicLogin, completeAnthropicLogin, disconnectAnthropicOAuth };
}
