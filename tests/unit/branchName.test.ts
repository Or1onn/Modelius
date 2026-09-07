// The model is asked for a bare slug; these are the deviations seen in practice.
import { describe, it, expect } from "vitest";
import { cleanBranchName } from "@/features/run-agent/lib/branchName";

describe("cleanBranchName", () => {
  it("passes a clean slug through", () => {
    expect(cleanBranchName("fix-auth-bug")).toBe("fix-auth-bug");
    expect(cleanBranchName("  Fix-Auth-Bug\n")).toBe("fix-auth-bug");
  });

  it("strips quotes, fences and trailing punctuation", () => {
    expect(cleanBranchName('"fix-auth-bug"')).toBe("fix-auth-bug");
    expect(cleanBranchName("`add-usage-meter`")).toBe("add-usage-meter");
    expect(cleanBranchName("fix-auth-bug.")).toBe("fix-auth-bug");
  });

  it("drops a conventional-commit prefix", () => {
    expect(cleanBranchName("fix/auth-token")).toBe("auth-token");
  });

  it("picks the slug line out of a chatty answer", () => {
    expect(cleanBranchName("Sure! Here it is:\nfix-auth-bug")).toBe("fix-auth-bug");
  });

  it("falls back to the first words when nothing looks like a slug", () => {
    expect(cleanBranchName("Fix the auth bug in the token check")).toBe("fix-the-auth-bug");
  });

  it("returns empty for unusable output", () => {
    expect(cleanBranchName("")).toBe("");
    expect(cleanBranchName("!!!")).toBe("");
  });

  it("rejects an over-long slug line and keeps four words", () => {
    const long = Array(10).fill("word").join("-");
    expect(cleanBranchName(long)).toBe("word-word-word-word");
  });
});
