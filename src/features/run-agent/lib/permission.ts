// permission.ts — answer a live run's `can_use_tool` control_request (the stdio control protocol
// agent.rs speaks with the claude CLI). The webview builds the control_response JSON line and the
// Rust `agent_respond` command writes it to the run's stdin.
import { invoke } from "@tauri-apps/api/core";

// What codeTransport packs into a `data-permission` part for one control_request.
export interface PermissionRequestData {
  streamId: string;
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
}

// `setMode` piggybacks a session permission-mode switch on the approval — plan approval allows
// ExitPlanMode and flips the rest of the turn to acceptEdits so the agent executes immediately.
// `updatedInput` overrides the echoed input — AskUserQuestion answers ride back this way
export function allowPermission(
  d: PermissionRequestData,
  opts?: { setMode?: string; updatedInput?: Record<string, unknown> }
): Promise<void> {
  return respond(d, {
    behavior: "allow",
    updatedInput: opts?.updatedInput ?? d.input,
    ...(opts?.setMode ? { updatedPermissions: [{ type: "setMode", mode: opts.setMode, destination: "session" }] } : {}),
  });
}

export function denyPermission(d: PermissionRequestData, message: string): Promise<void> {
  return respond(d, { behavior: "deny", message });
}

// The control_response line the CLI expects on stdin (shape probe-verified against claude 2.1.206).
// Exported pure so tests can lock the wire contract without a Tauri runtime.
export function buildControlResponse(requestId: string, response: unknown): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

function respond(d: PermissionRequestData, response: unknown): Promise<void> {
  return invoke("agent_respond", { streamId: d.streamId, payload: buildControlResponse(d.requestId, response) });
}
