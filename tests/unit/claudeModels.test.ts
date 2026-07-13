import { describe, it, expect } from "vitest";
import { currentClaudeModels } from "@/entities/session/api/claudeModels";

// /v1/models is newest-first; currentClaudeModels keeps the first (newest) model per generically
// derived family and drops prior generations — with no hardcoded family list.
describe("currentClaudeModels", () => {
  const m = (id: string) => ({ id, name: id });

  it("keeps the newest per family and drops older generations", () => {
    const out = currentClaudeModels([
      m("claude-opus-4-8"),
      m("claude-sonnet-4-6"),
      m("claude-opus-4-1-20250805"), // older Opus → dropped (same family as 4-8)
      m("claude-haiku-4-5-20251001"),
      m("claude-3-5-sonnet-20241022"), // older Sonnet → dropped
      m("claude-3-haiku-20240307"), // older Haiku → dropped
    ]);
    expect(out.map((x) => x.id)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
  });

  it("surfaces a new family (e.g. Fable) with no code change", () => {
    const out = currentClaudeModels([m("claude-opus-4-8"), m("claude-fable-5"), m("claude-sonnet-4-6")]);
    expect(out.map((x) => x.id)).toContain("claude-fable-5");
    expect(out).toHaveLength(3);
  });
});
