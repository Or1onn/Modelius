// openai.ts — OpenAI Chat Completions streaming + ChatGPT subscription path (Responses API via Rust).
import { invoke } from "@tauri-apps/api/core";
import { SYSTEM_PROMPT } from "@/shared/config/prompts";
import { getKey } from "@/entities/session/model/keys";
import { getOpenAIAuth, disconnectOpenAIOAuth } from "@/entities/session/model/openaiSession";
import { channelToDeltas } from "@/features/stream-completion/lib/channel";
import type { ChatMsg, Delta, ImagePart } from "@/entities/model/model/backend";

const dataUrl = (img: ImagePart) => `data:${img.mime};base64,${img.data}`;

// Only o-series and gpt-5 accept `reasoning_effort`; gpt-4o & friends 400 on it.
function openaiSupportsReasoning(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

// Stream the ChatGPT subscription via Rust `openai_responses_stream` (Responses API).
export async function* streamChatGPT(
  model: string,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false,
  web = false,
  signal?: AbortSignal
): AsyncGenerator<Delta> {
  const auth = await getOpenAIAuth();
  if (!auth) throw new Error("No Codex account connected.");

  // Codex needs non-empty `instructions`; naming the model lets it self-report instead of guessing "GPT-5".
  const base = messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;
  const instructions = modelName ? `${base}\nYou are powered by the model named ${modelName}.` : base;
  const input = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      type: "message",
      role: m.role,
      content: [
        ...(m.content || !m.images?.length ? [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] : []),
        ...(m.images?.map((img) => ({ type: "input_image", image_url: dataUrl(img) })) ?? []),
      ],
    }));

  const body: Record<string, unknown> = { model, instructions, input, stream: true, store: false };
  // `summary: "auto"` streams a reasoning summary we can show.
  if (thinking) body.reasoning = { effort: "medium", summary: "auto" };
  // Server-side web search (Responses API built-in tool).
  if (web) body.tools = [{ type: "web_search" }];

  const streamId = crypto.randomUUID(); // lets Stop cancel the upstream request mid-flight
  yield* channelToDeltas(
    (onEvent) => invoke("openai_responses_stream", { body, accessToken: auth.token, accountId: auth.accountId, streamId, onEvent }),
    (u) => ({ kind: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens, reasoningTokens: u.reasoning_tokens, metered: false }),
    // 401 = subscription session revoked/dead; drop the token so Providers shows disconnected.
    (msg) => { if (/^ChatGPT 401\b/.test(msg)) disconnectOpenAIOAuth(); },
    signal,
    streamId
  );
}

// OpenAI key path: stream Chat Completions directly via browser fetch + SSE.
export async function* streamChat(
  model: string,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false,
  web = false,
  signal?: AbortSignal
): AsyncGenerator<Delta> {
  const key = await getKey("openai");
  if (!key) throw new Error("No OpenAI API key configured.");

  // Fold the shared system contract + name the model for self-report; single leading system message.
  const base = messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;
  const sysContent = modelName ? `${base}\nYou are powered by the model named ${modelName}.` : base;
  const withId: ChatMsg[] = [{ role: "system", content: sysContent }, ...messages.filter((m) => m.role !== "system")];
  // Images → content array ({text} + {image_url}); plain text stays a string.
  const reqMsgs = withId.map((m) =>
    m.images?.length
      ? {
          role: m.role,
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.images.map((img) => ({ type: "image_url", image_url: { url: dataUrl(img) } })),
          ],
        }
      : { role: m.role, content: m.content }
  );

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: reqMsgs,
      stream: true,
      stream_options: { include_usage: true }, // final chunk carries real token usage
      ...(thinking && openaiSupportsReasoning(model) ? { reasoning_effort: "medium" } : {}),
      // Chat Completions web search is only available on the *-search-preview models.
      ...(web && /search/i.test(model) ? { web_search_options: {} } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    const retry = Number(res.headers.get("retry-after"));
    const suffix = Number.isFinite(retry) && retry > 0 ? ` (retry-after: ${retry}s)` : "";
    throw new Error(`OpenAI ${res.status}${suffix}: ${detail.slice(0, 300)}`);
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
        const fr: string | undefined = json.choices?.[0]?.finish_reason;
        if (fr) yield { kind: "stop", reason: fr };
        // include_usage delivers usage on a trailing empty-choices chunk. prompt_tokens
        // already includes cached tokens — don't pass cacheRead or costOf double-counts.
        if (json.usage)
          yield { kind: "usage", inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, metered: true };
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
}
