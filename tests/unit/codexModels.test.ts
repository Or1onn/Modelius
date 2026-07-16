import { describe, it, expect } from "vitest";
import { mapCodex } from "@/entities/session/api/codexModels";

// Shape mirrors codex app-server model/list.
const raw = {
  data: [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      hidden: false,
      inputModalities: ["text", "image"],
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
        { reasoningEffort: "max" },
        { reasoningEffort: "ultra" },
      ],
    },
    {
      id: "gpt-5.6-luna",
      displayName: "GPT-5.6-Luna",
      inputModalities: ["text"],
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    },
    // Plan-locked variants — must be dropped.
    { id: "gpt-locked-a", displayName: "Hidden", hidden: true },
    { id: "gpt-locked-b", displayName: "Upgrade", upgrade: { plan: "pro" } },
    { id: "gpt-locked-c", displayName: "UpgradeInfo", upgradeInfo: { cta: "x" } },
  ],
};

describe("mapCodex", () => {
  it("drops plan-locked models and maps fields + efforts", () => {
    const models = mapCodex(raw);
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);

    const sol = models[0];
    expect(sol.name).toBe("GPT-5.6-Sol");
    expect(sol.vision).toBe(true);
    expect(sol.isDefault).toBe(true);
    expect(sol.defaultEffort).toBe("low");
    expect(sol.efforts).toEqual(["low", "high", "max", "ultra"]);

    const luna = models[1];
    expect(luna.vision).toBe(false);
    expect(luna.isDefault).toBe(false);
    expect(luna.defaultEffort).toBe("medium");
  });

  it("falls back to id for name and medium for a missing/invalid default effort", () => {
    const models = mapCodex({ data: [{ id: "gpt-x", supportedReasoningEfforts: [{ reasoningEffort: "bogus" }] }] });
    expect(models[0].name).toBe("gpt-x");
    expect(models[0].defaultEffort).toBe("medium");
    expect(models[0].efforts).toEqual([]); // unknown effort filtered out
  });

  it("tolerates an empty/absent data array", () => {
    expect(mapCodex({})).toEqual([]);
    expect(mapCodex({ data: [] })).toEqual([]);
  });
});
