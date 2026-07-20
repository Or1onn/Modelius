// anthropic.ts — Claude (Messages API) streaming, proxied through Rust (subscription
// OAuth accounts reject browser-origin requests with a CORS org error).
import { invoke } from "@tauri-apps/api/core";
import type { ChatMsg, Delta } from "@/entities/model/model/backend";
import type { EffortLevel } from "@/entities/model/model/apiIds";
import { effortSurface, pickEffort } from "@/entities/session/api/effortSurface";
import { getKey } from "@/entities/session/model/keys";
import { getAnthropicAccessToken, handleAnthropicUnauthorized } from "@/entities/session/model/anthropicSession";
import { channelToDeltas } from "@/features/stream-completion/lib/channel";
import { recordLimits } from "@/entities/session/model/usageLimits";
import { systemBase, systemInstructions } from "@/features/stream-completion/lib/instructions";

// Extended thinking lands with Claude 3.7; older 3.x models 400 on the param.
function anthropicSupportsThinking(model: string): boolean {
  return !/claude-3-5|claude-3-haiku|claude-3-opus|claude-3-sonnet/i.test(model);
}

export async function* streamClaude(
  model: string,
  messages: ChatMsg[],
  modelName?: string,
  thinking = false,
  effort: EffortLevel | "auto" = "auto",
  web = false,
  signal?: AbortSignal
): AsyncGenerator<Delta> {
  // Messages API takes only user/assistant turns; system is top-level.
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
  // Prompt caching: mark the last message so the prefix is cached and reused on the
  // next same-model turn — cuts time-to-first-token. Cache is per-model (cross-model switches miss).
  if (msgs.length) {
    const last = msgs[msgs.length - 1];
    if (typeof last.content === "string") {
      last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    } else {
      last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
    }
  }
  // Shared system contract (carries the summary block after compaction).
  const sysBase = systemBase(messages);
  // Messages API requires max_tokens (no "unlimited"). Only a ceiling, billed per
  // actual output. 8192 = safe max across every registry model.
  const body: Record<string, unknown> = { model, max_tokens: 8192, stream: true, messages: msgs };
  // Effort-capable models use adaptive thinking (budget_tokens 400s on Opus 4.7/4.8);
  // older ones use the fixed budget. display:summarized keeps the trace visible.
  const eff = effortSurface("anthropic", model);
  if (thinking) {
    if (eff) {
      body.thinking = { type: "adaptive", display: "summarized" };
    } else if (anthropicSupportsThinking(model)) {
      body.thinking = { type: "enabled", budget_tokens: 2048 };
    }
  }
  // Effort applies whenever supported, independent of the thinking toggle. Levels the model can't
  // use (e.g. Auto→Sonnet with max selected) fall back to its default rather than 400ing.
  if (eff) body.output_config = { effort: pickEffort(eff, effort) };
  // Server-side web search: Claude runs searches itself and folds results (with citations) into
  // the streamed answer. The tool/result content blocks are ignored by the Rust SSE parser; only
  // text/thinking deltas surface, so the answer streams as usual.
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];

  // Prefer OAuth over a pasted API key.
  const oauthToken = await getAnthropicAccessToken();
  let token: string;
  let oauth = false;
  if (oauthToken) {
    token = oauthToken;
    oauth = true;
    // OAuth: first system block must be EXACTLY this string or it's rejected as a
    // disguised 429. Model-name line goes in a separate block.
    const sys: { type: "text"; text: string }[] = [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: sysBase },
    ];
    if (modelName) sys.push({ type: "text", text: `You are powered by the model named ${modelName}.` });
    body.system = sys;
  } else {
    const key = await getKey("anthropic");
    if (!key) throw new Error("No Anthropic API key or account connected.");
    token = key;
    body.system = systemInstructions(messages, modelName);
  }

  // Bridge the Rust channel into this generator. `oauth` (subscription) = not metered; the key path bills.
  const streamId = crypto.randomUUID(); // lets Stop cancel the upstream request mid-flight
  yield* channelToDeltas(
    (onEvent) => invoke("anthropic_messages_stream", { body, token, oauth, streamId, onEvent }),
    (u) => ({
      kind: "usage",
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheRead: u.cache_read,
      cacheWrite: u.cache_write,
      metered: !oauth,
    }),
    // OAuth-path 401 may be transient (rotation race / briefly-expired access token), not a
    // revoked session — try a refresh and only disconnect if it's definitively rejected.
    // (Key-path 401s aren't our token to clear.)
    (msg) => { if (oauth && /^Anthropic 401\b/.test(msg)) void handleAnthropicUnauthorized(); },
    signal,
    streamId,
    (headers) => recordLimits("anthropic", headers)
  );
}
