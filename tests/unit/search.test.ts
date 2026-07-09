import { describe, it, expect } from "vitest";
import { matches, snippet } from "@/features/search-chats/lib/search";

describe("matches", () => {
  it("is case- and diacritic-insensitive", () => {
    expect(matches("Café Society", "cafe")).toBe(true);
    expect(matches("HELLO", "hello")).toBe(true);
  });
  it("is false for no match or empty query", () => {
    expect(matches("hello", "xyz")).toBe(false);
    expect(matches("hello", "")).toBe(false);
  });
});

describe("snippet", () => {
  it("returns the match with surrounding context, original casing", () => {
    const s = snippet("The quick brown fox jumps", "QUICK");
    expect(s).not.toBeNull();
    expect(s!.match).toBe("quick");
    expect(s!.before).toContain("The ");
  });
  it("is null when the query is absent", () => {
    expect(snippet("nothing here", "zzz")).toBeNull();
  });
});
