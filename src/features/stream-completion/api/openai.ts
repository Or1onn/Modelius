// openai.ts — OpenAI Responses API streaming: key path (direct fetch) + ChatGPT subscription path (via Rust).
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

// Models that accept the Responses API `image_generation` tool (calls gpt-image under the hood);
// unsupported models 400 on it. o3-mini is the odd one out in the o3 family.
function openaiSupportsImageGen(model: string): boolean {
  return /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o3)/i.test(model) && !/^o3-mini/i.test(model);
}

// Responses API `input` items: system handled via `instructions`, images as input_image parts.
function toResponsesInput(messages: ChatMsg[]) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      type: "message",
      role: m.role,
      content: [
        ...(m.content || !m.images?.length ? [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] : []),
        ...(m.images?.map((img) => ({ type: "input_image", image_url: dataUrl(img) })) ?? []),
      ],
    }));
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
  const input = toResponsesInput(messages);

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

// OpenAI key path: stream the Responses API directly via browser fetch + SSE. Responses (not Chat
// Completions) so the built-in tools work: web_search, and image_generation on capable models.
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

  // Shared system contract + model self-id goes into `instructions` (Responses has no system message).
  const base = messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;
  const instructions = modelName ? `${base}\nYou are powered by the model named ${modelName}.` : base;
  const tools: Record<string, unknown>[] = [];
  if (web) tools.push({ type: "web_search" });
  // The model invokes gpt-image itself when the turn asks for an image; unused, the tool costs nothing.
  if (openaiSupportsImageGen(model)) tools.push({ type: "image_generation" });

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      instructions,
      input: toResponsesInput(messages),
      stream: true,
      store: false,
      ...(thinking && openaiSupportsReasoning(model) ? { reasoning: { effort: "medium", summary: "auto" } } : {}),
      ...(tools.length ? { tools } : {}),
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
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue; /* keep-alive / partial line */
      }
      switch (json.type) {
        case "response.output_text.delta":
          if (typeof json.delta === "string") yield { kind: "text", text: json.delta };
          break;
        case "response.reasoning_summary_text.delta":
          if (typeof json.delta === "string") yield { kind: "thinking", text: json.delta };
          break;
        // A finished image_generation tool call carries the whole image (base64) in `result`.
        case "response.output_item.done": {
          const it = json.item;
          if (it?.type === "image_generation_call" && typeof it.result === "string")
            yield { kind: "image", dataUrl: `data:image/${it.output_format || "png"};base64,${it.result}` };
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          // input_tokens already includes cached tokens — don't pass cacheRead or costOf double-counts.
          const u = json.response?.usage;
          if (u)
            yield { kind: "usage", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, reasoningTokens: u.output_tokens_details?.reasoning_tokens, metered: true };
          const r: string | undefined = json.response?.incomplete_details?.reason;
          if (r) yield { kind: "stop", reason: r };
          return;
        }
        case "response.failed":
        case "error":
          throw new Error(json.response?.error?.message ?? json.message ?? "OpenAI response failed");
      }
    }
  }
}
