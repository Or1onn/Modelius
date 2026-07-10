import { describe, it, expect } from "vitest";
import { permissionDataFrom } from "@/features/run-agent/lib/codeTransport";
import { buildControlResponse } from "@/features/run-agent/lib/permission";

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
