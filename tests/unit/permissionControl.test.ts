import { describe, it, expect } from "vitest";
import { permissionDataFrom, codexPermissionDataFrom, kimiPermissionDataFrom } from "@/features/run-agent/lib/codeTransport";
import { buildControlResponse, buildJsonRpcResult, buildAcpResult, pickAcpOption } from "@/features/run-agent/lib/permission";

// Wire-contract lock for the stdio permission protocol, verified live against claude 2.1.206
// (phase-0 probes): CAPTURED_REQUEST is a real can_use_tool line the CLI emitted, and the
// allow/deny payloads asserted below are the exact lines the CLI accepted (tool executed /
// tool blocked). If these tests fail after an edit, the app no longer speaks the proven shape.
const CAPTURED_REQUEST = JSON.parse(
  '{"type":"control_request","request_id":"6dddb154-ccf5-413e-8c42-3c52b388a1da","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"C:\\\\ws\\\\probe.txt","content":"hi"},"description":"probe.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01JqSX2Tq5JfjrqBopmPj6Zr"}}'
);

describe("permission control protocol", () => {
  it("decodes a real can_use_tool control_request into a data-permission part", () => {
    const part = permissionDataFrom(CAPTURED_REQUEST, "stream-1");
    expect(part).toEqual({
      type: "data-permission",
      id: "6dddb154-ccf5-413e-8c42-3c52b388a1da",
      data: {
        streamId: "stream-1",
        requestId: "6dddb154-ccf5-413e-8c42-3c52b388a1da",
        toolName: "Write",
        toolUseId: "toolu_01JqSX2Tq5JfjrqBopmPj6Zr",
        input: { file_path: "C:\\ws\\probe.txt", content: "hi" },
      },
    });
  });

  it("ignores non-permission control traffic and non-control lines", () => {
    expect(permissionDataFrom({ type: "control_request", request_id: "x", request: { subtype: "hook_callback" } }, "s")).toBeNull();
    expect(permissionDataFrom({ type: "control_response", response: { subtype: "success", request_id: "int-1" } }, "s")).toBeNull();
    expect(permissionDataFrom({ type: "stream_event", event: {} }, "s")).toBeNull();
    // request_id is the answer's routing key — a request without one can't be answered, so no card
    expect(permissionDataFrom({ type: "control_request", request: { subtype: "can_use_tool", tool_name: "Write" } }, "s")).toBeNull();
  });

  it("builds the exact allow line the CLI accepted in the probe", () => {
    const input = { file_path: "C:\\ws\\probe.txt", content: "hi" };
    expect(JSON.parse(buildControlResponse("6dddb154-ccf5-413e-8c42-3c52b388a1da", { behavior: "allow", updatedInput: input }))).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "6dddb154-ccf5-413e-8c42-3c52b388a1da",
        response: { behavior: "allow", updatedInput: input },
      },
    });
  });

  it("builds the exact deny line the CLI accepted in the probe", () => {
    expect(JSON.parse(buildControlResponse("r1", { behavior: "deny", message: "User denied this in the probe" }))).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "r1", response: { behavior: "deny", message: "User denied this in the probe" } },
    });
  });
});

// Codex app-server approval flow, verified live against codex-cli 0.142.5 (probe P5):
// CODEX_APPROVAL is a real item/commandExecution/requestApproval server request the CLI emitted,
// and the accept line asserted below is the exact response after which the command executed.
const CODEX_APPROVAL = {
  method: "item/commandExecution/requestApproval",
  id: 0,
  params: {
    threadId: "019f5756-46ed-7093-8ba4-bf2a6e907a73",
    turnId: "019f5756-5aad-7c73-a487-66733e0f2371",
    itemId: "call_1",
    startedAtMs: 1783876710752,
    environmentId: "local",
    reason: "probe needs approval card",
    command: "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command \"node -e \\\"console.log('probe-ran')\\\"\"",
    cwd: "D:\\Modelius",
    commandActions: [{ type: "unknown", command: "node -e \"console.log('probe-ran')\"" }],
    proposedExecpolicyAmendment: ["node", "-e", "console.log('probe-ran')"],
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "-e", "console.log('probe-ran')"] } }, "cancel"],
  },
};

describe("codex approval protocol", () => {
  it("decodes a real requestApproval server request into a codex data-permission part", () => {
    const part = codexPermissionDataFrom(CODEX_APPROVAL, "stream-1");
    expect(part).toEqual({
      type: "data-permission",
      id: "0",
      data: {
        streamId: "stream-1",
        requestId: "0",
        toolName: "Bash",
        toolUseId: "call_1",
        // the model's logical command from commandActions, not the powershell.exe wrapper
        input: { command: 'node -e "console.log(\'probe-ran\')"', cwd: "D:\\Modelius", reason: "probe needs approval card" },
        kind: "codex",
        rpcId: 0,
      },
    });
  });

  it("maps fileChange approvals onto the Edit card and rejects unknown server requests", () => {
    const part = codexPermissionDataFrom(
      { method: "item/fileChange/requestApproval", id: 7, params: { itemId: "fc_1", grantRoot: "D:\\ws", reason: "outside workspace" } },
      "s"
    );
    expect(part?.data.toolName).toBe("Edit");
    expect(part?.data.input).toEqual({ file_path: "D:\\ws", reason: "outside workspace" });
    // non-approval server requests are answered with a JSON-RPC error by the transport, not a card
    expect(codexPermissionDataFrom({ method: "item/tool/requestUserInput", id: 8, params: {} }, "s")).toBeNull();
    // notifications (no id) must never become cards
    expect(codexPermissionDataFrom({ method: "item/agentMessage/delta", params: {} }, "s")).toBeNull();
  });

  it("builds the exact accept line the CLI executed on in the probe (numeric id stays numeric)", () => {
    expect(buildJsonRpcResult(0, { decision: "accept" })).toBe('{"id":0,"result":{"decision":"accept"}}');
    expect(buildJsonRpcResult("r-1", { decision: "decline" })).toBe('{"id":"r-1","result":{"decision":"decline"}}');
    // codex's dialect omits the jsonrpc field entirely (probe-verified)
    expect(JSON.parse(buildJsonRpcResult(0, {}))).not.toHaveProperty("jsonrpc");
  });
});

// Kimi ACP permission flow, verified live against @moonshot-ai/kimi-code 0.25.0 (probe P5):
// KIMI_PERMISSION is a real session/request_permission server request the CLI emitted, and the
// selected-outcome line asserted below is the exact response after which the command executed.
const KIMI_PERMISSION = {
  jsonrpc: "2.0",
  id: 0,
  method: "session/request_permission",
  params: {
    sessionId: "session_a7ae7a72-1800-4f3b-8e87-23cb10ff8eeb",
    options: [
      { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
      { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "0:call_1",
      title: "Bash",
      content: [{ type: "content", content: { type: "text", text: '{"command":"node -e \\"console.log(\'probe-ran\')\\""}' } }],
    },
  },
};

describe("kimi acp permission protocol", () => {
  it("decodes a real session/request_permission into a kimi data-permission part", () => {
    const part = kimiPermissionDataFrom(KIMI_PERMISSION, "stream-1");
    expect(part).toEqual({
      type: "data-permission",
      id: "0",
      data: {
        streamId: "stream-1",
        requestId: "0",
        toolName: "Bash", // kimi titles are already canonical tool names
        toolUseId: "0:call_1",
        input: { command: "node -e \"console.log('probe-ran')\"" }, // parsed from the args JSON
        kind: "kimi",
        rpcId: 0,
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
          { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });

  it("only decodes permission requests with an answerable id", () => {
    expect(kimiPermissionDataFrom({ jsonrpc: "2.0", method: "session/update", params: {} }, "s")).toBeNull();
    expect(kimiPermissionDataFrom({ jsonrpc: "2.0", method: "session/request_permission", params: {} }, "s")).toBeNull();
    expect(kimiPermissionDataFrom({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file", params: {} }, "s")).toBeNull();
  });

  it("picks the one-shot option for the card's Allow/Deny answer", () => {
    const options = KIMI_PERMISSION.params.options;
    expect(pickAcpOption(options, "allow")?.optionId).toBe("approve_once");
    expect(pickAcpOption(options, "reject")?.optionId).toBe("reject");
    // *_once missing → the *_always variant, then anything offered
    expect(pickAcpOption([{ optionId: "a", kind: "allow_always" }], "allow")?.optionId).toBe("a");
    expect(pickAcpOption([{ optionId: "x", kind: "weird" }], "reject")?.optionId).toBe("x");
    expect(pickAcpOption([], "allow")).toBeNull();
  });

  it("builds the exact strict JSON-RPC answer the CLI executed on in the probe", () => {
    // The "jsonrpc" field is mandatory in the ACP dialect — its absence is a silent hang.
    expect(buildAcpResult(0, { outcome: { outcome: "selected", optionId: "approve_once" } })).toBe(
      '{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"approve_once"}}}'
    );
    expect(JSON.parse(buildAcpResult("r-1", {}))).toHaveProperty("jsonrpc", "2.0");
  });
});
