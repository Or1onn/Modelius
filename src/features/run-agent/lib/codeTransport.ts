// codeTransport.ts — a custom AI SDK ChatTransport that drives a coding-CLI harness. Instead of an
// HTTP endpoint it invokes the Rust `agent_run` command (a dumb pipe of raw CLI stdout lines),
// decodes each line with the per-harness transform, and streams AI SDK UIMessageChunks.
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createTransformer } from "./transform";
import { createCodexTransformer } from "./codexTransform";
import type { PermissionRequestData } from "./permission";
import { bumpTurnActivity, clearTurnStatus, noteTurnStderr } from "./turnStatus";

// Raw pipe events from Rust agent.rs (PipeEvent).
type PipeEvent =
  | { type: "line"; data: string }
  | { type: "error"; data: string }
  | { type: "stderr"; data: string }
  | { type: "done" };

// Everything the Rust `agent_run` command needs for one turn. Resolved per-send (model/cwd/harness
// can change between turns, routing keys are fetched lazily) by the store that owns the transport.
export interface RunConfig {
  harness: string; // "claude-code" | "codex"
  model: string;
  cwd: string;
  permissionMode: string;
  effort: string; // Anthropic effort level, or "" for no override
  target?: { protocol: "anthropic" | "openai"; baseUrl: string; apiKey: string };
  codexAuth?: { idToken: string; accessToken: string; refreshToken?: string; accountId: string };
  claudeToken?: string;
}

export interface ResolvedSend {
  prompt: string;
  resume?: string; // prior CLI session id (from the last assistant message's metadata)
  run: RunConfig;
}

// Decode a `can_use_tool` control_request stdout line into the `data-permission` part the
// transcript renders as an Allow/Deny card (answered via permission.ts). Null for any other
// control traffic. Pure + exported so tests can feed it real captured CLI lines
// (shape probe-verified against claude 2.1.206).
export function permissionDataFrom(
  parsed: unknown,
  streamId: string
): { type: "data-permission"; id: string; data: PermissionRequestData } | null {
  const ctrl = parsed as {
    type?: string;
    request_id?: string;
    request?: { subtype?: string; tool_name?: string; tool_use_id?: string; input?: Record<string, unknown> };
  };
  if (ctrl.type !== "control_request" || ctrl.request?.subtype !== "can_use_tool" || !ctrl.request_id) return null;
  return {
    type: "data-permission",
    id: ctrl.request_id,
    data: {
      streamId,
      requestId: ctrl.request_id,
      toolName: ctrl.request.tool_name ?? "unknown",
      toolUseId: ctrl.request.tool_use_id,
      input: ctrl.request.input ?? {},
    },
  };
}

export class CodeChatTransport implements ChatTransport<UIMessage> {
  // `chatId` keys the warm CLI session in Rust (session.rs): stdin_prompt harnesses keep one live
  // process per chat across turns. `resolve` turns the current message list + store config into a
  // concrete run (prompt, resume id, harness/model/cwd/permission + routing). Throwing rejects the
  // send (surfaced by the SDK).
  constructor(
    private chatId: string,
    private resolve: (messages: UIMessage[]) => Promise<ResolvedSend>
  ) {}

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
        // UIMessageChunk type is stricter, so cast at the boundary.
        const push = (chunk: unknown) => {
          try {
            controller.enqueue(chunk as UIMessageChunk);
          } catch {
            // stream already closed (aborted) — drop
          }
        };
        channel.onmessage = (ev) => {
          if (ev.type === "line") {
            bumpTurnActivity(this.chatId);
            let parsed: unknown;
            try {
              parsed = JSON.parse(ev.data);
            } catch {
              return; // non-JSON line (banner/log) — ignore
            }
            // Permission prompt (stdio control protocol): surface as a data part the transcript
            // renders as an Allow/Deny card, answered via `agent_respond` (permission.ts). Lives
            // here, not in the transform — the transport owns the streamId the answer targets.
            if ((parsed as { type?: string }).type === "control_request") {
              const perm = permissionDataFrom(parsed, streamId);
              if (perm) push(perm);
              return; // other control traffic is not transcript content
            }
            for (const chunk of transform(parsed)) push(chunk);
          } else if (ev.type === "stderr") {
            // Live CLI stderr (retry/backoff chatter) — transient status, not transcript content.
            noteTurnStderr(this.chatId, ev.data);
          } else if (ev.type === "error") {
            // Routed runs fail for reasons a native run never hits (protocol translation, models
            // without tool calling) — say where the run actually went and what to try.
            const hint = run.target
              ? `\n\nThis model runs through the local gateway to ${run.target.baseUrl}. Tool support depends on the target model/provider — if tools fail, try a native model.`
              : "";
            clearTurnStatus(this.chatId);
            push({ type: "error", errorText: ev.data + hint });
          } else {
            clearTurnStatus(this.chatId);
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        };

        // Seed the silence detector at turn start so the pre-first-token wait counts too.
        bumpTurnActivity(this.chatId);
        const call = invoke("agent_run", {
          harness: run.harness,
          model: run.model,
          prompt,
          cwd: run.cwd,
          permissionMode: run.permissionMode,
          effort: run.effort,
          resume,
          target: run.target,
          codexAuth: run.codexAuth,
          claudeToken: run.claudeToken,
          sessionKey: this.chatId,
          streamId,
          onEvent: channel,
        });
        call.catch((e) => {
          clearTurnStatus(this.chatId);
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
            clearTurnStatus(this.chatId);
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
