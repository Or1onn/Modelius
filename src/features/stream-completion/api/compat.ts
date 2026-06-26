// compat.ts — stream an OpenAI-compatible endpoint: Rust SSE proxy under Tauri (CORS-free),
// direct browser fetch otherwise (dev). Keyed providers (Gemini/Groq) bill per token with real
// pricing; local endpoints (Ollama) are unmetered.
import { invoke } from "@tauri-apps/api/core";
import { SYSTEM_PROMPT } from "@/shared/config/prompts";
import { getKey } from "@/entities/session/model/keys";
import { isKeyProvider } from "@/entities/session/model/keyProviders";
import { isTauri } from "@/shared/api/tauri";
import { channelToDeltas } from "@/features/stream-completion/lib/channel";
import type { Backend, ChatMsg, Delta } from "@/entities/model/model/backend";
import type { EffortLevel } from "@/entities/model/model/apiIds";

export async function* streamCompat(
  backend: Backend,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false,
  effort: EffortLevel | "auto" = "auto",
  signal?: AbortSignal
): AsyncGenerator<Delta> {
  // A fixed baseUrl endpoint: Gemini/Groq (keyed) or Ollama (local, no key).
  const baseUrl = backend.baseUrl;
  if (!baseUrl) throw new Error("Endpoint is no longer configured.");
  const name = backend.label ?? "Endpoint";
  // Keyed provider (Gemini/Groq) → the key under its provider id; local (Ollama) → none.
  const key = backend.providerId ? await getKey(backend.providerId) : "";
  // Gemini/Groq bill per token (real pricing); local endpoints are unmetered.
  const metered = isKeyProvider(backend.providerId ?? "");

  // Same system contract as the other providers: shared prompt + model self-id line.
  const base = messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;
  const sysContent = modelName ? `${base}\nYou are powered by the model named ${modelName}.` : base;
  const reqMsgs = [
    { role: "system", content: sysContent },
    ...messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
  ];
  // OpenRouter-only extras: exact cost accounting, and reasoning when Thinking is on. Effort maps to
  // reasoning depth (Claude/etc. translate it to a token budget); xhigh/max clamp to OpenRouter's "high".
  const isOpenRouter = backend.providerId === "openrouter";
  const orEffort: "low" | "medium" | "high" | null =
    effort === "auto" ? null : effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
  const body = {
    model: backend.model,
    messages: reqMsgs,
    stream: true,
    stream_options: { include_usage: true },
    ...(isOpenRouter ? { usage: { include: true } } : {}),
    ...(isOpenRouter && thinking ? { reasoning: orEffort ? { effort: orEffort } : { enabled: true } } : {}),
  };

  if (!isTauri()) {
    yield* browserStream(baseUrl, name, key, body, metered, signal);
    return;
  }

  const streamId = crypto.randomUUID(); // lets Stop cancel the upstream request mid-flight
  yield* channelToDeltas(
    (onEvent) => invoke("compat_chat_stream", { baseUrl, apiKey: key, provider: name, body, streamId, onEvent }),
    (u) => ({ kind: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens, metered, cost: u.cost ?? undefined }),
    undefined,
    signal,
    streamId
  );
}

// Browser-dev fallback: works only when the endpoint sends CORS headers (e.g. Ollama with OLLAMA_ORIGINS).
async function* browserStream(baseUrl: string, name: string, key: string, body: unknown, metered: boolean, signal?: AbortSignal): AsyncGenerator<Delta> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${name} ${res.status}: ${detail.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta: string | undefined = json.choices?.[0]?.delta?.content;
        if (delta) yield { kind: "text", text: delta };
        // DeepSeek streams the trace as `reasoning_content`; OpenRouter normalizes it to `reasoning`.
        const think: string | undefined = json.choices?.[0]?.delta?.reasoning_content ?? json.choices?.[0]?.delta?.reasoning;
        if (think) yield { kind: "thinking", text: think };
        if (json.usage)
          yield {
            kind: "usage",
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
            metered,
            cost: typeof json.usage.cost === "number" ? json.usage.cost : undefined,
          };
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
}
