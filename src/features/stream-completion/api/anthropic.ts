// anthropic.ts — real Claude (Messages API) streaming, proxied through Rust.
// Subscription (OAuth) accounts reject browser-origin requests with a CORS org
// error, so the request runs from Rust (the `anthropic_messages_stream` command)
// and streams text deltas back over a Tauri channel.
import { Channel, invoke } from "@tauri-apps/api/core";
import { SYSTEM_PROMPT } from "@/shared/config/prompts";
import type { ChatMsg, Delta } from "@/entities/model/model/backend";
import { anthropicEffortTier, resolveEffort, type EffortLevel } from "@/entities/model/model/apiIds";
import { getKey } from "@/entities/session/model/keys";
import { getAnthropicAccessToken, disconnectAnthropicOAuth } from "@/entities/session/model/anthropicSession";

type StreamEvent =
  | { type: "chunk"; data: string }
  | { type: "thinking"; data: string }
  | { type: "usage"; data: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number } }
  | { type: "done" }
  | { type: "error"; data: string };

// Extended thinking lands with Claude 3.7; the older 3.x models 400 on the param.
function anthropicSupportsThinking(model: string): boolean {
  return !/claude-3-5|claude-3-haiku|claude-3-opus|claude-3-sonnet/i.test(model);
}

export async function* streamClaude(
  model: string,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false,
  effort: EffortLevel | "auto" = "auto"
): AsyncGenerator<Delta> {
  // Messages API takes only user/assistant turns; system goes top-level.
  type TextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
  type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: { type: "ephemeral" } };
  type Block = TextBlock | ImageBlock;
  const msgs: { role: string; content: string | Block[] }[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (!m.images?.length) return { role: m.role, content: m.content };
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const img of m.images) blocks.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
      return { role: m.role, content: blocks };
    });
  // Prompt caching: mark the last message so the whole prefix (system + prior
  // turns) is cached and reused on the next same-model turn — cuts time-to-first-
  // token on long chats. Output is identical: the cache stores computed state, not
  // a shortcut. Cross-model switches don't hit it (cache is per-model).
  if (msgs.length) {
    const last = msgs[msgs.length - 1];
    if (typeof last.content === "string") {
      last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    } else {
      last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
    }
  }
  // Shared system contract (carries the summary block when context was compacted).
  const sysBase = messages.find((m) => m.role === "system")?.content || SYSTEM_PROMPT;
  // Messages API requires max_tokens (no "unlimited" like OpenAI). It's only a
  // ceiling — billed per actual output — so set it high enough not to truncate
  // long answers. 8192 is the safe max across every model in the registry.
  const body: Record<string, unknown> = { model, max_tokens: 8192, stream: true, messages: msgs };
  // Effort-capable models use adaptive thinking (budget_tokens 400s on Opus 4.7/4.8);
  // older ones keep the fixed-budget form. display:summarized keeps the trace visible.
  const tier = anthropicEffortTier(model);
  if (thinking) {
    if (tier) {
      body.thinking = { type: "adaptive", display: "summarized" };
    } else if (anthropicSupportsThinking(model)) {
      body.thinking = { type: "enabled", budget_tokens: 2048 };
    }
  }
  // Effort applies whenever the model supports it, independent of the thinking toggle.
  // Final gate: resolveEffort clamps levels the actual model can't use (e.g. Auto→Sonnet
  // with max selected).
  if (tier) body.output_config = { effort: resolveEffort(tier, effort) };

  // Prefer a connected Claude account (OAuth) over a pasted API key.
  const oauthToken = await getAnthropicAccessToken();
  let token: string;
  let oauth = false;
  if (oauthToken) {
    token = oauthToken;
    oauth = true;
    // OAuth: the first system block must be EXACTLY this string or the request is
    // rejected as a disguised 429. The model-name line goes in a separate block.
    const sys: { type: "text"; text: string }[] = [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: sysBase },
    ];
    if (modelName) sys.push({ type: "text", text: `You are powered by the model named ${modelName}.` });
    body.system = sys;
  } else {
    const key = getKey("anthropic");
    if (!key) throw new Error("No Anthropic API key or account connected.");
    token = key;
    body.system = modelName ? `${sysBase}\nYou are powered by the model named ${modelName}.` : sysBase;
  }

  // Bridge the Rust channel into this async generator via a simple queue.
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
    // `oauth` (subscription) is the authoritative metered flag — the key path bills.
    else if (msg.type === "usage")
      queue.push({
        kind: "usage",
        inputTokens: msg.data.input_tokens,
        outputTokens: msg.data.output_tokens,
        cacheRead: msg.data.cache_read,
        cacheWrite: msg.data.cache_write,
        metered: !oauth,
      });
    else if (msg.type === "error") {
      error = msg.data;
      finished = true;
    } else finished = true;
    ping();
  };

  const call = invoke("anthropic_messages_stream", { body, token, oauth, onEvent: channel });
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
      // A 401 on the OAuth path means the connected account session is revoked/dead;
      // drop the stored token so the Providers UI flips to disconnected. (Key-path
      // 401s aren't our token to clear.)
      if (oauth && /^Anthropic 401\b/.test(error)) disconnectAnthropicOAuth();
      throw new Error(error);
    }
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await call.catch(() => {});
}
