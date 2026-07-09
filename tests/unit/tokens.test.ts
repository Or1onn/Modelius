import { describe, it, expect } from "vitest";
import { estimateTokens, fmtCompact, ctxTokens } from "@/shared/lib/tokens";

describe("estimateTokens", () => {
  it("rounds up at ~4 chars/token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("fmtCompact", () => {
  it("keeps < 1000 exact, else K/M with a trailing-zero trim", () => {
    expect(fmtCompact(500)).toBe("500");
    expect(fmtCompact(1000)).toBe("1K");
    expect(fmtCompact(1200)).toBe("1.2K");
    expect(fmtCompact(1_200_000)).toBe("1.2M");
  });
});

describe("ctxTokens", () => {
  it("parses K/M registry strings", () => {
    expect(ctxTokens("32K")).toBe(32_000);
    expect(ctxTokens("128K")).toBe(128_000);
    expect(ctxTokens("1M")).toBe(1_000_000);
  });
});
