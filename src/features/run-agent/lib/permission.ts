// permission.ts — answer a live run's permission prompt. Two wire dialects, one card UI:
// - claude: `can_use_tool` control_request → control_response line (stdio control protocol,
//   probe-verified 2.1.206)
// - codex: `item/*/requestApproval` JSON-RPC server request → {id, result:{decision}} line
//   (app-server, probe-verified 0.142.5)
// The webview builds the answer line and the Rust `agent_respond` command writes it to the run's
// stdin.
import { invoke } from "@tauri-apps/api/core";

// What codeTransport packs into a `data-permission` part for one permission request.
export interface PermissionRequestData {
  streamId: string;
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  // "codex" answers as a JSON-RPC result; absent/anything else answers as a control_response.
  kind?: "codex";
  // The raw JSON-RPC id of a codex server request — kept untyped-raw so a numeric id goes back
  // as a number (string ids echo as strings).
  rpcId?: number | string;
}

// `setMode` piggybacks a session permission-mode switch on the approval — plan approval allows
// ExitPlanMode and flips the rest of the turn to acceptEdits so the agent executes immediately.
// `updatedInput` overrides the echoed input — AskUserQuestion answers ride back this way.
// (Claude-only concepts; a codex approval is just the decision.)
export function allowPermission(
  d: PermissionRequestData,
  opts?: { setMode?: string; updatedInput?: Record<string, unknown> }
): Promise<void> {
  if (d.kind === "codex") {
    return respondRaw(d.streamId, buildJsonRpcResult(d.rpcId!, { decision: "accept" }));
  }
  return respond(d, {
    behavior: "allow",
    updatedInput: opts?.updatedInput ?? d.input,
    ...(opts?.setMode ? { updatedPermissions: [{ type: "setMode", mode: opts.setMode, destination: "session" }] } : {}),
  });
}

// Codex has no deny-message slot — the decision alone is the native contract.
export function denyPermission(d: PermissionRequestData, message: string): Promise<void> {
  if (d.kind === "codex") {
    return respondRaw(d.streamId, buildJsonRpcResult(d.rpcId!, { decision: "decline" }));
  }
  return respond(d, { behavior: "deny", message });
}

// The control_response line the claude CLI expects on stdin (probe-verified 2.1.206).
// Exported pure so tests can lock the wire contract without a Tauri runtime.
export function buildControlResponse(requestId: string, response: unknown): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

// The JSON-RPC response line the codex app-server expects on stdin (probe-verified 0.142.5:
// no "jsonrpc" field, id echoed with its original type).
export function buildJsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ id, result });
}

function respond(d: PermissionRequestData, response: unknown): Promise<void> {
  return respondRaw(d.streamId, buildControlResponse(d.requestId, response));
}

function respondRaw(streamId: string, payload: string): Promise<void> {
  return invoke("agent_respond", { streamId, payload });
}
