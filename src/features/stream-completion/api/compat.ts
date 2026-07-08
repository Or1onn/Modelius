// compat.ts — stream an OpenAI-compatible endpoint: Rust SSE proxy under Tauri (CORS-free),
// direct browser fetch otherwise (dev). Keyed providers (Gemini/Groq) bill per token with real
// pricing; local endpoints (Ollama) are unmetered.
import { invoke } from "@tauri-apps/api/core";
import { getKey } from "@/entities/session/model/keys";
import { supportsImageOutput } from "@/entities/model/lib/pricingSource";
import { isKeyProvider } from "@/entities/session/model/keyProviders";
import { isTauri } from "@/shared/api/tauri";
import { channelToDeltas } from "@/features/stream-completion/lib/channel";
import { systemInstructions } from "@/features/stream-completion/lib/instructions";
import { sseJson } from "@/features/stream-completion/lib/sse";
import type { Backend, ChatMsg, Delta } from "@/entities/model/model/backend";
import type { EffortLevel } from "@/entities/model/model/apiIds";

export async function* streamCompat(
  backend: Backend,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false,
  effort: EffortLevel | "auto" = "auto",
  web = false,
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
  const sysContent = systemInstructions(messages, modelName);
  const reqMsgs = [
    { role: "system", content: sysContent },
    ...messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
  ];
  // OpenRouter-only extras: exact cost accounting, and reasoning when Thinking is on. Effort maps to
  // reasoning depth (Claude/etc. translate it to a token budget); xhigh/max clamp to OpenRouter's "high".
  const isOpenRouter = backend.providerId === "openrouter";
  const orEffort: "low" | "medium" | "high" | null =
    effort === "auto" ? null : effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
  // OpenRouter runs a server-side web search when the model id carries the ":online" suffix.
  const model = isOpenRouter && web ? `${backend.model}:online` : backend.model;
  // Image-output chat model: catalog flag; Gemini "-image" id fallback when the catalog is cold.
  const imageOut =
    supportsImageOutput(backend.model) ??
    (backend.providerId === "google" && /-image(-preview)?$/i.test(backend.model));
  const body = {
    model,
    messages: reqMsgs,
    stream: true,
    stream_options: { include_usage: true },
    ...(imageOut ? { modalities: ["image", "text"] } : {}),
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
    (u) => ({ kind: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens, reasoningTokens: u.reasoning_tokens, metered, cost: u.cost ?? undefined }),
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
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(baseUrl.includes("openrouter.ai") ? { "HTTP-Referer": "https://modelius.app", "X-Title": "Modelius" } : {}),
    },
    body: JSON.stringify(body),
  });
  for await (const json of sseJson(res, name)) {
    const delta: string | undefined = json.choices?.[0]?.delta?.content;
    if (delta) yield { kind: "text", text: delta };
    // Image-output models: images arrive as data URLs in delta.images (streaming) or message.images.
    const imgs = json.choices?.[0]?.delta?.images ?? json.choices?.[0]?.message?.images;
    if (Array.isArray(imgs))
      for (const im of imgs) {
        const url = im?.image_url?.url;
        if (typeof url === "string") yield { kind: "image", dataUrl: url };
      }
    const fr: string | undefined = json.choices?.[0]?.finish_reason;
    if (fr) yield { kind: "stop", reason: fr };
    // DeepSeek streams the trace as `reasoning_content`; OpenRouter normalizes it to `reasoning`.
    const think: string | undefined = json.choices?.[0]?.delta?.reasoning_content ?? json.choices?.[0]?.delta?.reasoning;
    if (think) yield { kind: "thinking", text: think };
    if (json.usage)
      yield {
        kind: "usage",
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens,
        metered,
        cost: typeof json.usage.cost === "number" ? json.usage.cost : undefined,
      };
  }
}
