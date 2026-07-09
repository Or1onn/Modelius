// gateways.ts — user-configured model endpoints for Code mode (LiteLLM proxy, DeepSeek, Z.ai,
// Moonshot, …). Each gateway declares which protocol its endpoint speaks — the Anthropic Messages
// API or OpenAI chat/completions — so the local proxy knows whether to translate or pass through.
// Non-secret config lives in localStorage under a modelius.* key; the API key goes to the OS
// keychain (secret_*) and is only read at send time.
import { useEffect, useReducer } from "react";
import { secretSet, secretDelete } from "@/shared/api/secrets";

export type GatewayProtocol = "anthropic" | "openai";

export interface CodeGateway {
  id: string;
  name: string;
  baseUrl: string;
  model: string; // passed to the CLI's --model flag
  protocol?: GatewayProtocol; // absent in configs saved before the field existed → anthropic
}

const STORE_KEY = "modelius.code.gateways";
const EVT = "modelius-gateways-changed";

export const gatewaySecretKey = (id: string): string => `code.gateway.${id}`;

export function getGateways(): CodeGateway[] {
  try {
    const arr = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((g) => g && typeof g.id === "string")
      .map((g) => ({ ...g, protocol: g.protocol === "openai" ? "openai" : "anthropic" }) as CodeGateway);
  } catch {
    return [];
  }
}

function save(list: CodeGateway[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* quota — drop silently */
  }
  window.dispatchEvent(new Event(EVT));
}

// Store the key first — if the keychain write fails, no orphan config appears in the list.
export async function addGateway(cfg: Omit<CodeGateway, "id">, apiKey: string): Promise<void> {
  const id = crypto.randomUUID();
  await secretSet(gatewaySecretKey(id), apiKey);
  save([...getGateways(), { id, ...cfg }]);
}

export async function removeGateway(id: string): Promise<void> {
  save(getGateways().filter((g) => g.id !== id));
  await secretDelete(gatewaySecretKey(id)).catch(() => {});
}

// Subscribe to gateway-list changes (same-tab custom event; cross-tab storage).
export function useGateways(): CodeGateway[] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const h = () => force();
    window.addEventListener(EVT, h);
    window.addEventListener("storage", h);
    return () => {
      window.removeEventListener(EVT, h);
      window.removeEventListener("storage", h);
    };
  }, []);
  return getGateways();
}
