import { describe, it, expect } from "vitest";
import {
  artifactId,
  isLargeBlock,
  parseCodeBlocks,
  detectLang,
  formatBytes,
} from "@/entities/artifact/model/artifacts";

describe("artifactId", () => {
  it("is deterministic, content-addressed, and trims", () => {
    expect(artifactId("abc")).toBe(artifactId("abc"));
    expect(artifactId(" abc ")).toBe(artifactId("abc"));
    expect(artifactId("abc")).toMatch(/^code-[0-9a-f]{8}$/);
    expect(artifactId("abc")).not.toBe(artifactId("abd"));
  });
});

describe("isLargeBlock", () => {
  it("is true for many lines or large bytes, false for short blocks", () => {
    expect(isLargeBlock(Array(15).fill("x").join("\n"))).toBe(true);
    expect(isLargeBlock("x".repeat(5000))).toBe(true);
    expect(isLargeBlock("one\ntwo")).toBe(false);
  });
});

describe("parseCodeBlocks", () => {
  it("extracts fenced blocks with lang + code", () => {
    const blocks = parseCodeBlocks("pre\n```js\nconst x = 1;\n```\npost");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("js");
    expect(blocks[0].code).toBe("const x = 1;");
  });
});

describe("detectLang", () => {
  it("normalizes aliases, sniffs empty fences, and upgrades JSX", () => {
    expect(detectLang("typescript", "")).toBe("ts");
    expect(detectLang("python", "")).toBe("py");
    expect(detectLang("", '{"a":1}')).toBe("json");
    expect(detectLang("js", "return <App/>;")).toBe("jsx");
  });
});

describe("formatBytes", () => {
  it("renders B under 1 KB, else rounded KB", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});
