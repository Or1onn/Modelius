// codeTransport.ts — a custom AI SDK ChatTransport that drives a coding-CLI harness. Instead of an
// HTTP endpoint it invokes the Rust `agent_run` command (a dumb pipe of raw CLI stdout lines),
// decodes each line with the per-harness transform, and streams AI SDK UIMessageChunks. Mirrors
// 1code's IPCChatTransport, stripped to Modelius's needs.
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createTransformer } from "./transform";
import { createCodexTransformer } from "./codexTransform";

// Raw pipe events from Rust agent.rs (PipeEvent).
type PipeEvent = { type: "line"; data: string } | { type: "error"; data: string } | { type: "done" };

// Everything the Rust `agent_run` command needs for one turn. Resolved per-send (model/cwd/harness
// can change between turns, routing keys are fetched lazily) by the store that owns the transport.
export interface RunConfig {
  harness: string; // "claude-code" | "codex"
  model: string;
  cwd: string;
  permissionMode: string;
  target?: { protocol: "anthropic" | "openai"; baseUrl: string; apiKey: string };
  codexAuth?: { idToken: string; accessToken: string; refreshToken?: string; accountId: string };
  claudeToken?: string;
}

export interface ResolvedSend {
  prompt: string;
  resume?: string; // prior CLI session id (from the last assistant message's metadata)
  run: RunConfig;
}

export class CodeChatTransport implements ChatTransport<UIMessage> {
  // `resolve` turns the current message list + store config into a concrete run (prompt, resume id,
  // harness/model/cwd/permission + routing). Throwing rejects the send (surfaced by the SDK).
  constructor(private resolve: (messages: UIMessage[]) => Promise<ResolvedSend>) {}

  async sendMessages(options: {
    messages: UIMessage[];
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const { prompt, resume, run } = await this.resolve(options.messages);
    const streamId = crypto.randomUUID();
    const transform = run.harness === "codex" ? createCodexTransformer() : createTransformer();
    const channel = new Channel<PipeEvent>();

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // Our transform yields the (structurally identical) local chunk shape; the SDK's generic
        // UIMessageChunk type is stricter, so cast at the boundary (mirrors 1code's `any`).
        const push = (chunk: unknown) => {
          try {
            controller.enqueue(chunk as UIMessageChunk);
          } catch {
            // stream already closed (aborted) — drop
          }
        };
        channel.onmessage = (ev) => {
          if (ev.type === "line") {
            let parsed: unknown;
            try {
              parsed = JSON.parse(ev.data);
            } catch {
              return; // non-JSON line (banner/log) — ignore
            }
            for (const chunk of transform(parsed)) push(chunk);
          } else if (ev.type === "error") {
            push({ type: "error", errorText: ev.data });
          } else {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        };

        const call = invoke("agent_run", {
          harness: run.harness,
          model: run.model,
          prompt,
          cwd: run.cwd,
          permissionMode: run.permissionMode,
          resume,
          target: run.target,
          codexAuth: run.codexAuth,
          claudeToken: run.claudeToken,
          streamId,
          onEvent: channel,
        });
        call.catch((e) => {
          push({ type: "error", errorText: e instanceof Error ? e.message : String(e) });
          try {
            controller.close();
          } catch {
            // already closed
          }
        });

        options.abortSignal?.addEventListener(
          "abort",
          () => {
            void invoke("cancel_stream", { streamId }).catch(() => {});
            try {
              controller.close();
            } catch {
              // already closed
            }
          },
          { once: true }
        );
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null; // local app — no server-held stream to resume
  }
}
