import { describe, it, expect, beforeEach } from "vitest";
import { peekCodeModelGroups } from "@/entities/agent/model/codeModels";

// The picker must distinguish the CLI's native login (well-trodden tool loop) from non-native
// picks that run through the local gateway proxy — the "via gateway" suffix carries that.
describe("code model groups", () => {
  beforeEach(() => localStorage.clear());

  it("suffixes only non-native groups with via gateway", () => {
    localStorage.setItem(
      "modelius.code.gateways",
      JSON.stringify([{ id: "g1", name: "LiteLLM", baseUrl: "http://x", model: "m", protocol: "anthropic" }])
    );
    const groups = peekCodeModelGroups("claude-code");
    const native = groups[0];
    expect(native.label.includes("via gateway")).toBe(false);
    expect(native.models.every((m) => m.kind === "anthropic")).toBe(true);
    const gateways = groups.find((g) => g.models.some((m) => m.kind === "gateway"));
    expect(gateways?.label).toBe("Gateways · via gateway");
  });

  it("leaves a native-only harness unmarked", () => {
    for (const g of peekCodeModelGroups("claude-code")) {
      if (g.models.every((m) => m.kind === "anthropic" || m.kind === "codex")) {
        expect(g.label.includes("via gateway")).toBe(false);
      }
    }
  });
});
