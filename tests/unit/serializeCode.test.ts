import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { codeToMarkdown } from "@/features/export-chat/model/serializeCode";

const meta = { title: "T" };

function asstMsg(parts: any[], metadata?: Record<string, unknown>): UIMessage {
  return { id: "a1", role: "assistant", parts, metadata } as unknown as UIMessage;
}

function toolPart(name: string, over: Partial<Record<string, unknown>> = {}) {
  return { type: `tool-${name}`, toolCallId: "toolu_1", state: "output-available", input: {}, output: "", ...over };
}

describe("codeToMarkdown", () => {
  it("marks subagent calls (composite toolCallId) with a badge", () => {
    const md = codeToMarkdown(
      [asstMsg([
        toolPart("Bash", { toolCallId: "toolu_parent:toolu_child", input: { command: "ls" }, output: "ok" }),
        toolPart("Bash", { toolCallId: "toolu_plain", input: { command: "ls" }, output: "ok" }),
      ])],
      meta,
    );
    expect(md).toContain("**⚙ Bash** `ls` _(subagent)_");
    expect(md.match(/_\(subagent\)_/g)).toHaveLength(1);
  });

  it("renders the Agent report from output.content instead of raw JSON", () => {
    const md = codeToMarkdown(
      [asstMsg([
        toolPart("Agent", {
          input: { description: "Plan Semagraph", prompt: "x".repeat(9000), subagent_type: "Plan" },
          output: {
            status: "completed",
            prompt: "x".repeat(9000),
            content: [{ type: "text", text: "# The plan\nStep 1" }],
          },
        }),
      ])],
      meta,
    );
    expect(md).toContain("**⚙ Agent** `Plan Semagraph`");
    expect(md).toContain("# The plan");
    expect(md).not.toContain('"status"');
  });

  it("targets Grep by pattern (not path) and ToolSearch by query", () => {
    const md = codeToMarkdown(
      [asstMsg([
        toolPart("Grep", { input: { pattern: "foo|bar", path: "C:/x" }, output: "hit" }),
        toolPart("ToolSearch", { input: { query: "select:Write" }, output: { matches: [] } }),
      ])],
      meta,
    );
    expect(md).toContain("**⚙ Grep** `foo|bar`");
    expect(md).toContain("**⚙ ToolSearch** `select:Write`");
  });

  it("normalizes structured outputs: Read file content, Bash stdout/stderr, block arrays", () => {
    const md = codeToMarkdown(
      [asstMsg([
        toolPart("Read", { input: { file_path: "a.ts" }, output: { type: "text", file: { filePath: "a.ts", content: "line1\nline2" } } }),
        toolPart("Bash", { input: { command: "run" }, output: { stdout: "out-text", stderr: "boom", interrupted: false } }),
        toolPart("Fetch", { output: [{ type: "text", text: "block-text" }] }),
      ])],
      meta,
    );
    expect(md).toContain("line1\nline2");
    expect(md).not.toContain('"filePath"');
    expect(md).toContain("out-text\n[stderr]\nboom");
    expect(md).toContain("block-text");
  });

  it("shows cached tokens next to the uncached input count", () => {
    const md = codeToMarkdown(
      [asstMsg([{ type: "text", text: "done" }], {
        inputTokens: 2, outputTokens: 35401, cacheReadInputTokens: 95849, cacheCreationInputTokens: 233,
      })],
      meta,
    );
    expect(md).toContain("2 in + 96.1k cached / 35401 out");
  });

  it("labels duration as wall-clock", () => {
    const md = codeToMarkdown(
      [asstMsg([{ type: "text", text: "done" }], { inputTokens: 1, outputTokens: 1, durationMs: 1997800 })],
      meta,
    );
    expect(md).toContain("1997.8s wall");
  });
});
