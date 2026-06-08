// openai.ts — real OpenAI Chat Completions streaming, plus the ChatGPT
// subscription path (Responses API via the Codex backend, proxied through Rust).
import { Channel, invoke } from "@tauri-apps/api/core";
import { SYSTEM_PROMPT } from "@/shared/config/prompts";
import { getKey } from "@/entities/session/model/keys";
import { getOpenAIAuth, disconnectOpenAIOAuth } from "@/entities/session/model/openaiSession";
import type { ChatMsg, Delta, ImagePart } from "@/entities/model/model/backend";

const dataUrl = (img: ImagePart) => `data:${img.mime};base64,${img.data}`;

type StreamEvent =
  | { type: "chunk"; data: string }
  | { type: "thinking"; data: string }
  | { type: "usage"; data: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number } }
  | { type: "done" }
  | { type: "error"; data: string };

// Only the o-series and gpt-5 families accept `reasoning_effort` on the key path;
// gpt-4o & friends 400 on it, so gate the param by model id.
function openaiSupportsReasoning(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

// Stream from the ChatGPT subscription via the Rust `openai_responses_stream`
// command (Responses API). Bridges the Rust channel into an async generator.
export async function* streamChatGPT(
  model: string,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false
): AsyncGenerator<Delta> {
  const auth = await getOpenAIAuth();
  if (!auth) throw new Error("No ChatGPT account connected.");

  // Codex needs a non-empty `instructions`; naming the model lets it self-report
  // correctly instead of guessing "GPT-5".
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
  // `summary: "auto"` makes the Responses API stream a reasoning summary we can show.
  if (thinking) body.reasoning = { effort: "medium", summary: "auto" };

  const channel = new Channel<StreamEvent>();
  const queue: Delta[] = [];
  let finished = false;
  let error: string | null = null;
  let wake: (() => void) | null = null;
  const ping = () => {
    wake?.();
    wake = null;
  };
  channel.onmessage = (msg) => {
    if (msg.type === "chunk") queue.push({ kind: "text", text: msg.data });
    else if (msg.type === "thinking") queue.push({ kind: "thinking", text: msg.data });
    else if (msg.type === "usage")
      queue.push({ kind: "usage", inputTokens: msg.data.input_tokens, outputTokens: msg.data.output_tokens, metered: false });
    else if (msg.type === "error") {
      error = msg.data;
      finished = true;
    } else finished = true;
    ping();
  };

  const call = invoke("openai_responses_stream", {
    body,
    accessToken: auth.token,
    accountId: auth.accountId,
    onEvent: channel,
  });
  call.catch((e) => {
    error = e instanceof Error ? e.message : String(e);
    finished = true;
    ping();
  });

  while (true) {
    if (queue.length) {
      yield queue.shift() as Delta;
      continue;
    }
    if (error) {
      // A 401 means the subscription session is revoked/dead, not just rate-limited;
      // drop the stored token so the Providers UI flips to disconnected.
      if (/^ChatGPT 401\b/.test(error)) disconnectOpenAIOAuth();
      throw new Error(error);
    }
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await call.catch(() => {});
}

// Async generator yielding content deltas as they stream in.
export async function* streamChat(
  model: string,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false
): AsyncGenerator<Delta> {
  const key = getKey("openai");
  if (!key) throw new Error("No OpenAI API key configured.");

  // Fold the caller's system prompt (the shared contract) and name the model so
  // it self-reports correctly. Always emit a single leading system message.
  const base = messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;
  const sysContent = modelName ? `${base}\nYou are powered by the model named ${modelName}.` : base;
  const withId: ChatMsg[] = [{ role: "system", content: sysContent }, ...messages.filter((m) => m.role !== "system")];
  // Messages with images become a content array ({text} + {image_url}); plain text stays a string.
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
        // include_usage delivers usage on a trailing chunk with empty choices.
        // (prompt_tokens already includes any cached tokens, so don't pass cacheRead
        // — costOf's Anthropic-style cache math would otherwise double-count it.)
        if (json.usage)
          yield { kind: "usage", inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens, metered: true };
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
}
