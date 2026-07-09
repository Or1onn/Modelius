import { describe, it, expect } from "vitest";
import { humanizeError } from "@/shared/lib/errors";

describe("humanizeError", () => {
  it("detects network failures", () => {
    expect(humanizeError("TypeError: Failed to fetch")).toMatch(/network error/i);
  });

  it("passes through a plain non-provider message", () => {
    expect(humanizeError("No OpenAI API key configured.")).toBe("No OpenAI API key configured.");
  });

  it("formats a rate limit with the api message and retry-after", () => {
    const msg = humanizeError('Anthropic 429 (retry-after: 5s): {"error":{"message":"slow down"}}');
    expect(msg).toMatch(/rate limit reached/i);
    expect(msg).toContain("slow down");
    expect(msg).toContain("5s");
  });

  it("names the missing model on a 404", () => {
    const msg = humanizeError('OpenAI 404: {"error":{"message":"model: gpt-x does not exist"}}');
    expect(msg).toMatch(/model not found/i);
    expect(msg).toContain("gpt-x");
  });

  it("reports service unavailability on 5xx", () => {
    expect(humanizeError("Anthropic 500: {}")).toContain("(500)");
  });
});
