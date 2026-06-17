// openaiAuth.ts — "Sign in with ChatGPT" OAuth (Codex flow) login.
import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CLIENT_ID,
  AUTH_URL,
  REDIRECT_URI,
  SCOPES,
  OPENAI_OAUTH_EVT,
  saveOpenAIToken,
  hasOpenAIOAuth,
  disconnectOpenAIOAuth,
  type TokenResponse,
} from "@/entities/session/model/openaiSession";

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

// Full one-shot login: open the browser, capture the localhost callback, exchange.
export async function connectOpenAI(): Promise<void> {
  const { verifier, challenge } = await generatePkce();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  // Start the loopback listener before opening the browser.
  const codePromise = invoke<string>("openai_await_callback", { state });

  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  await openUrl(url.toString());

  const code = await codePromise;

  const data = await invoke<TokenResponse>("openai_oauth_token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    },
  });

  await saveOpenAIToken(data);
}

// Subscribe to connect/disconnect changes (same-tab + cross-tab).
export function useOpenAIAuth() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const h = () => force();
    window.addEventListener(OPENAI_OAUTH_EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(OPENAI_OAUTH_EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return { connected: hasOpenAIOAuth(), connectOpenAI, disconnectOpenAIOAuth };
}
