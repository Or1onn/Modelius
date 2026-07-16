import { describe, it, expect } from "vitest";
import { mapKimi } from "@/entities/session/api/kimiModels";

// Locked against the session/new result captured live from @moonshot-ai/kimi-code 0.25.0
// (scripts/probeKimiAcp.mjs P3): the model catalog rides a configOptions "model" select.
const CAPTURED_SESSION_NEW_RESULT = {
  sessionId: "session_b4524113-a32d-4475-8763-af0f13463ea0",
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "probe/probe-model",
      options: [{ value: "probe/probe-model", name: "Probe Model" }],
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
        { value: "auto", name: "Auto" },
        { value: "yolo", name: "YOLO" },
      ],
    },
  ],
};

describe("mapKimi", () => {
  it("mines the model select from a captured session/new result, marking the current default", () => {
    expect(mapKimi(CAPTURED_SESSION_NEW_RESULT)).toEqual([
      { id: "probe/probe-model", name: "Probe Model", isDefault: true },
    ]);
  });

  it("never picks the mode select and returns [] on unrecognized payloads", () => {
    expect(mapKimi({ configOptions: CAPTURED_SESSION_NEW_RESULT.configOptions.slice(1) })).toEqual([]);
    expect(mapKimi(null)).toEqual([]);
    expect(mapKimi({})).toEqual([]);
    expect(mapKimi({ configOptions: "nope" })).toEqual([]);
    expect(mapKimi({ configOptions: [{ id: "model", options: [{ name: "no value" }] }] })).toEqual([]);
  });
});
