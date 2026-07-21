// codeTransport.ts — a custom AI SDK ChatTransport that drives a coding-CLI harness. Instead of an
// HTTP endpoint it invokes the Rust `agent_run` command (a dumb pipe of raw CLI stdout lines),
// decodes each line with the per-harness transform, and streams AI SDK UIMessageChunks.
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createTransformer } from "./transform";
import { createCodexAppServerTransformer } from "./codexAppServerTransform";
import { createKimiAcpTransformer, kimiToolName, kimiToolInput } from "./kimiAcpTransform";
import { buildAcpResult, type AcpPermissionOption, type PermissionRequestData } from "./permission";
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
  harness: string; // "claude-code" | "codex" | "kimi-code"
  model: string;
  cwd: string;
  permissionMode: string;
  effort: string; // reasoning effort (claude --effort / codex turn-start override), "" = none
  target?: { protocol: "anthropic" | "openai"; baseUrl: string; apiKey: string };
  codexAuth?: { idToken: string; accessToken: string; refreshToken?: string; accountId: string };
  claudeToken?: string;
}

// An image attached to the turn: MIME + base64 payload (no data-URL prefix). Per-turn content the
// Rust side wraps in each harness's native image content block (agent.rs ImageInput).
export interface CodeImage {
  mime: string;
  data: string;
}

export interface ResolvedSend {
  prompt: string;
  images?: CodeImage[]; // vision attachments on this turn
  resume?: string; // prior CLI session id (from the last assistant message's metadata)
  run: RunConfig;
}

// Decode a codex app-server SERVER REQUEST (JSON-RPC {id, method, params} from the CLI to us)
// into the `data-permission` part the transcript renders as an Allow/Deny card. Approval methods
// map onto the canonical tool names the card already knows how to summarize; anything else
// returns null (the transport answers it with a JSON-RPC error so the server never hangs).
// Pure + exported so tests can feed it real captured lines (probe-verified codex-cli 0.142.5).
export function codexPermissionDataFrom(
  parsed: unknown,
  streamId: string
): { type: "data-permission"; id: string; data: PermissionRequestData } | null {
  const req = parsed as { method?: string; id?: number | string; params?: Record<string, any> };
  if (typeof req.method !== "string" || req.id === undefined || req.id === null) return null;
  const p = req.params ?? {};
  let toolName: string;
  let input: Record<string, unknown>;
  if (req.method === "item/commandExecution/requestApproval") {
    // commandActions carries the model's logical command; params.command is the shell-wrapped
    // spawn string — prefer the readable one (same choice as the transform's Bash rows).
    const logical = Array.isArray(p.commandActions)
      ? p.commandActions.map((a: any) => a?.command).filter(Boolean).join(" && ")
      : "";
    toolName = "Bash";
    input = { command: logical || p.command || "", cwd: p.cwd, reason: p.reason };
  } else if (req.method === "item/fileChange/requestApproval") {
    toolName = "Edit";
    input = { file_path: p.grantRoot ?? "", reason: p.reason };
  } else {
    return null;
  }
  return {
    type: "data-permission",
    id: String(req.id),
    data: {
      streamId,
      requestId: String(req.id),
      toolName,
      toolUseId: typeof p.itemId === "string" ? p.itemId : undefined,
      input,
      kind: "codex",
      rpcId: req.id,
    },
  };
}

// Decode a kimi `session/request_permission` ACP server request into the `data-permission` part.
// The request's own options ride along — the answer must echo one of their optionIds
// (permission.ts pickAcpOption). Anything else with method+id gets a JSON-RPC error back from the
// transport so the agent never wedges on an unanswered request. Pure + exported for tests
// (shape probe-verified @moonshot-ai/kimi-code 0.25.0).
export function kimiPermissionDataFrom(
  parsed: unknown,
  streamId: string
): { type: "data-permission"; id: string; data: PermissionRequestData } | null {
  const req = parsed as { method?: string; id?: number | string; params?: Record<string, any> };
  if (req.method !== "session/request_permission" || req.id === undefined || req.id === null) return null;
  const p = req.params ?? {};
  const toolCall = p.toolCall ?? {};
  const options: AcpPermissionOption[] = Array.isArray(p.options)
    ? p.options
        .filter((o: any) => typeof o?.optionId === "string")
        .map((o: any) => ({ optionId: o.optionId, name: typeof o.name === "string" ? o.name : undefined, kind: String(o.kind ?? "") }))
    : [];
  return {
    type: "data-permission",
    id: String(req.id),
    data: {
      streamId,
      requestId: String(req.id),
      toolName: kimiToolName(toolCall),
      toolUseId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined,
      input: kimiToolInput(toolCall),
      kind: "kimi",
      rpcId: req.id,
      options,
    },
  };
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
    const { prompt, images, resume, run } = await this.resolve(options.messages);
    const streamId = crypto.randomUUID();
    const isCodex = run.harness === "codex";
    const isKimi = run.harness === "kimi-code";
    const transform = isCodex
      ? createCodexAppServerTransformer()
      : isKimi
        ? createKimiAcpTransformer()
        : createTransformer();
    const channel = new Channel<PipeEvent>();
    // Kimi permission requests still pending when the user hits Stop: ACP obliges the client to
    // answer every request, so the abort handler resolves them as "cancelled" before cancelling
    // the stream — an unanswered request could otherwise wedge the agent mid-cancel.
    const pendingKimiPerms = new Set<number | string>();

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
            // Permission prompts surface as a data part the transcript renders as an Allow/Deny
            // card, answered via `agent_respond` (permission.ts). Lives here, not in the
            // transform — the transport owns the streamId the answer targets.
            if (isCodex) {
              // Codex server request = JSON-RPC {id, method} from the CLI. Approvals become
              // cards; any other server request gets a JSON-RPC error line back immediately —
              // an unanswered request would block the app-server forever.
              const req = parsed as { method?: string; id?: number | string };
              if (typeof req.method === "string" && req.id !== undefined && req.id !== null) {
                const perm = codexPermissionDataFrom(parsed, streamId);
                if (perm) push(perm);
                else
                  void invoke("agent_respond", {
                    streamId,
                    payload: JSON.stringify({
                      id: req.id,
                      error: { code: -32601, message: `unsupported request: ${req.method}` },
                    }),
                  }).catch(() => {});
                return;
              }
            } else if (isKimi) {
              // Kimi ACP server request — same contract, strict JSON-RPC 2.0 (the error line
              // must carry "jsonrpc" or the SDK drops it and the agent hangs). fs/* and
              // terminal/* never arrive (capabilities declared false at initialize).
              const req = parsed as { method?: string; id?: number | string };
              if (typeof req.method === "string" && req.id !== undefined && req.id !== null) {
                const perm = kimiPermissionDataFrom(parsed, streamId);
                if (perm) {
                  pendingKimiPerms.add(req.id);
                  push(perm);
                } else {
                  void invoke("agent_respond", {
                    streamId,
                    payload: JSON.stringify({
                      jsonrpc: "2.0",
                      id: req.id,
                      error: { code: -32601, message: `unsupported request: ${req.method}` },
                    }),
                  }).catch(() => {});
                }
                return;
              }
            } else if ((parsed as { type?: string }).type === "control_request") {
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
          images: images ?? [],
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
            // Resolve any kimi permission requests still on screen as "cancelled" first —
            // session/cancel can't complete while a request is pending an answer. A request the
            // user already answered gets a benign duplicate-response no-op server-side.
            for (const id of pendingKimiPerms) {
              void invoke("agent_respond", {
                streamId,
                payload: buildAcpResult(id, { outcome: { outcome: "cancelled" } }),
              }).catch(() => {});
            }
            pendingKimiPerms.clear();
            void invoke("cancel_stream", { streamId }).catch(() => {});
            clearTurnStatus(this.chatId);
            // Don't close yet: the interrupt's final line (resume id + usage metadata) arrives
            // right after the CLI acks, and the Done event closes the stream then. The SDK keeps
            // consuming an open stream after abort, so those chunks still land on the message.
            // 2s backstop covers a deaf CLI (Rust kills it at 5s; late events hit a closed
            // stream harmlessly).
            setTimeout(() => {
              try {
                controller.close();
              } catch {
                // already closed
              }
            }, 2000);
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
