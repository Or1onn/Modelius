import { describe, it, expect, beforeEach, vi } from "vitest";
import { peekCodeModelGroups } from "@/entities/agent/model/codeModels";

// The CLI-login probe is Tauri-only; stub it so the sign-in gating can be exercised here.
const probe = vi.hoisted(() => ({ loggedIn: undefined as boolean | undefined }));
vi.mock("@/entities/agent/model/harnessStatus", () => ({ peekCliLoggedIn: () => probe.loggedIn }));

// The picker must distinguish the CLI's native login (well-trodden tool loop) from non-native
// picks that run through the local gateway proxy — the "via gateway" suffix carries that.
describe("code model groups", () => {
  beforeEach(() => {
    localStorage.clear();
    probe.loggedIn = undefined; // unprobed → treated as signed in
  });

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

  // The gateway now translates openai→anthropic too, so an Anthropic-protocol endpoint is no longer
  // filtered out of the openai-protocol (codex) harness.
  it("shows an anthropic-protocol gateway on the codex harness", () => {
    localStorage.setItem(
      "modelius.code.gateways",
      JSON.stringify([{ id: "g1", name: "Claude proxy", baseUrl: "http://x", model: "m", protocol: "anthropic" }])
    );
    const groups = peekCodeModelGroups("codex");
    const gateways = groups.find((g) => g.models.some((m) => m.kind === "gateway"));
    expect(gateways?.label).toBe("Gateways · via gateway");
  });

  // Anthropic-by-API-key is first-class: with a saved key + cached /v1/models it lists as a
  // connected "· via gateway" group on any harness — here the codex (openai-protocol) one.
  it("lists Anthropic-by-key as a connected group on the codex harness", () => {
    localStorage.setItem("modelius.keymeta.anthropic", JSON.stringify({ last6: "abc123" }));
    localStorage.setItem(
      "modelius.models.key:anthropic:abc123",
      JSON.stringify({ at: Date.now(), data: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }] })
    );
    const groups = peekCodeModelGroups("codex");
    const anthropic = groups.find((g) => g.models.some((m) => m.kind === "connected" && m.providerId === "anthropic"));
    expect(anthropic).toBeDefined();
    expect(anthropic?.label.endsWith("· via gateway")).toBe(true);
  });

  // A native group is the CLI's own account: with neither the app's login nor the CLI's own
  // credentials, listing it would offer models the user can't actually run.
  it("hides the native group when the account isn't signed in", () => {
    probe.loggedIn = false;
    expect(peekCodeModelGroups("claude-code").some((g) => g.models.some((m) => m.kind === "anthropic"))).toBe(false);
    expect(peekCodeModelGroups("codex").some((g) => g.models.some((m) => m.kind === "codex"))).toBe(false);
    expect(peekCodeModelGroups("kimi-code")).toEqual([]); // native-only harness → nothing left to pick
  });

  it("keeps the native group when the app holds the account login", () => {
    probe.loggedIn = false; // CLI has no credentials of its own
    localStorage.setItem("modelius.oauthmeta.anthropic", JSON.stringify({ hasRefresh: true }));
    expect(peekCodeModelGroups("claude-code")[0].models.every((m) => m.kind === "anthropic")).toBe(true);
    expect(peekCodeModelGroups("codex").some((g) => g.models.some((m) => m.kind === "codex"))).toBe(false);
  });
});
