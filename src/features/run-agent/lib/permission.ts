// permission.ts — answer a live run's permission prompt. Three wire dialects, one card UI:
// - claude: `can_use_tool` control_request → control_response line (stdio control protocol,
//   probe-verified 2.1.206)
// - codex: `item/*/requestApproval` JSON-RPC server request → {id, result:{decision}} line
//   (app-server, probe-verified 0.142.5)
// - kimi: `session/request_permission` ACP server request → {jsonrpc, id, result:{outcome}} line
//   echoing a server-provided optionId (probe-verified 0.25.0)
// The webview builds the answer line and the Rust `agent_respond` command writes it to the run's
// stdin.
import { invoke } from "@tauri-apps/api/core";

// One selectable answer on a kimi ACP permission request (probe-verified 0.25.0:
// approve_once/allow_once, approve_always/allow_always, reject/reject_once).
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

// What codeTransport packs into a `data-permission` part for one permission request.
export interface PermissionRequestData {
  streamId: string;
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  // "codex" answers as a JSON-RPC result, "kimi" as an ACP outcome; absent/anything else answers
  // as a control_response.
  kind?: "codex" | "kimi";
  // The raw JSON-RPC id of a codex/kimi server request — kept untyped-raw so a numeric id goes
  // back as a number (string ids echo as strings).
  rpcId?: number | string;
  // kimi only: the request's own options — the answer must echo one of their optionIds.
  options?: AcpPermissionOption[];
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
  if (d.kind === "kimi") {
    return respondRaw(d.streamId, buildAcpResult(d.rpcId!, acpOutcome(d.options ?? [], "allow")));
  }
  return respond(d, {
    behavior: "allow",
    updatedInput: opts?.updatedInput ?? d.input,
    ...(opts?.setMode ? { updatedPermissions: [{ type: "setMode", mode: opts.setMode, destination: "session" }] } : {}),
  });
}

// Codex/kimi have no deny-message slot — the decision alone is the native contract.
export function denyPermission(d: PermissionRequestData, message: string): Promise<void> {
  if (d.kind === "codex") {
    return respondRaw(d.streamId, buildJsonRpcResult(d.rpcId!, { decision: "decline" }));
  }
  if (d.kind === "kimi") {
    return respondRaw(d.streamId, buildAcpResult(d.rpcId!, acpOutcome(d.options ?? [], "reject")));
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

// The strict JSON-RPC 2.0 response line the kimi acp server expects — the "jsonrpc" field is
// mandatory (the ACP SDK silently drops messages without it, wedging the pending request).
export function buildAcpResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

// Pick the ACP option matching our Allow/Deny card. Prefer the one-shot kinds (the card answers
// one request); fall back to the *_always variant, then anything the server offered. No options
// at all → answer "cancelled" (the only optionId-free outcome).
export function pickAcpOption(options: AcpPermissionOption[], want: "allow" | "reject"): AcpPermissionOption | null {
  const kinds = want === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of kinds) {
    const hit = options.find((o) => o.kind === k);
    if (hit) return hit;
  }
  return options[0] ?? null;
}

function acpOutcome(options: AcpPermissionOption[], want: "allow" | "reject"): unknown {
  const pick = pickAcpOption(options, want);
  return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
}

function respond(d: PermissionRequestData, response: unknown): Promise<void> {
  return respondRaw(d.streamId, buildControlResponse(d.requestId, response));
}

function respondRaw(streamId: string, payload: string): Promise<void> {
  return invoke("agent_respond", { streamId, payload });
}
