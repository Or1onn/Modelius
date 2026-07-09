import { describe, it, expect } from "vitest";
import { diffLines } from "@/shared/lib/diff";

describe("diffLines", () => {
  it("emits a del + add for a changed middle line", () => {
    const rows = diffLines("a\nb\nc", "a\nx\nc");
    expect(rows.map((r) => r.type)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(rows[1].text).toBe("b");
    expect(rows[2].text).toBe("x");
  });

  it("is all context for identical input", () => {
    const rows = diffLines("a\nb", "a\nb");
    expect(rows.every((r) => r.type === "ctx")).toBe(true);
  });

  it("emits an add for an appended line", () => {
    const rows = diffLines("a", "a\nb");
    expect(rows.map((r) => r.type)).toEqual(["ctx", "add"]);
    expect(rows[1].newNo).toBe(2);
  });
});
