import { describe, it, expect } from "vitest";
import { createCodexAppServerTransformer } from "@/features/run-agent/lib/codexAppServerTransform";

// Wire-contract lock for the codex app-server v2 thread/turn surface, verified live against
// codex-cli 0.142.5 (scripts/probeCodexAppServer.mjs). The lines below are captured verbatim
// (ids shortened). If these tests fail after an edit, the app no longer speaks the proven shape.

const TH = "019f574e-65c9-7793-9b68-1e3715c06bc9";
const TU = "019f574e-798e-7a63-8b03-b4a9da803cdb";

const turnStarted = { method: "turn/started", params: { threadId: TH, turn: { id: TU, items: [], status: "inProgress" } } };
const msgDelta = (d: string) => ({ method: "item/agentMessage/delta", params: { threadId: TH, turnId: TU, itemId: "msg_1", delta: d } });
const msgCompleted = {
  method: "item/completed",
  params: { item: { type: "agentMessage", id: "msg_1", text: "Hello" }, threadId: TH, turnId: TU },
};
const tokenUsage = {
  method: "thread/tokenUsage/updated",
  params: {
    threadId: TH,
    turnId: TU,
    tokenUsage: {
      total: { totalTokens: 17, inputTokens: 12, cachedInputTokens: 3, outputTokens: 5, reasoningOutputTokens: 0 },
      last: { totalTokens: 17, inputTokens: 12, cachedInputTokens: 3, outputTokens: 5, reasoningOutputTokens: 0 },
      modelContextWindow: 258400,
    },
  },
};
const turnCompleted = (status: string) => ({
  method: "turn/completed",
  params: { threadId: TH, turn: { id: TU, items: [], status, error: null, durationMs: 5035 } },
});
// commandExecution captured with the shell-wrapped spawn string + the model's logical command
const cmdStarted = {
  method: "item/started",
  params: {
    item: {
      type: "commandExecution",
      id: "call_1",
      command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'echo probe-ran\'',
      cwd: "D:\\Modelius",
      status: "inProgress",
      commandActions: [{ type: "unknown", command: "echo probe-ran" }],
      aggregatedOutput: null,
      exitCode: null,
    },
    threadId: TH,
    turnId: TU,
  },
};
const cmdCompleted = {
  method: "item/completed",
  params: {
    item: {
      type: "commandExecution",
      id: "call_1",
      command: '"C:\\WINDOWS\\...powershell.exe" -Command \'echo probe-ran\'',
      cwd: "D:\\Modelius",
      status: "completed",
      commandActions: [{ type: "unknown", command: "echo probe-ran" }],
      aggregatedOutput: "probe-ran\r\n",
      exitCode: 0,
    },
    threadId: TH,
    turnId: TU,
  },
};

function run(msgs: unknown[]): any[] {
  const transform = createCodexAppServerTransformer();
  const chunks: any[] = [];
  for (const m of msgs) for (const c of transform(m)) chunks.push(c);
  return chunks;
}

describe("codex app-server transform", () => {
  it("streams agent message deltas as text chunks", () => {
    const chunks = run([turnStarted, msgDelta("He"), msgDelta("llo"), msgCompleted]);
    expect(chunks[0]).toEqual({ type: "start" });
    expect(chunks[1]).toEqual({ type: "start-step" });
    expect(chunks[2]).toEqual({ type: "text-start", id: "msg_1" });
    expect(chunks[3]).toEqual({ type: "text-delta", id: "msg_1", delta: "He" });
    expect(chunks[4]).toEqual({ type: "text-delta", id: "msg_1", delta: "llo" });
    expect(chunks[5]).toEqual({ type: "text-end", id: "msg_1" });
  });

  it("emits whole text when no deltas arrived (non-streaming provider)", () => {
    const chunks = run([turnStarted, msgCompleted]).filter((c) => c.type.startsWith("text-"));
    expect(chunks.map((c: any) => c.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(chunks[1].delta).toBe("Hello");
  });

  it("maps commandExecution to a canonical Bash tool with the logical command", () => {
    const chunks = run([turnStarted, cmdStarted, cmdCompleted]);
    const call = chunks.find((c) => c.type === "tool-input-available");
    // the readable model command, not the powershell.exe wrapper string
    expect(call).toEqual({ type: "tool-input-available", toolCallId: "call_1", toolName: "Bash", input: { command: "echo probe-ran" } });
    const out = chunks.find((c) => c.type === "tool-output-available");
    expect(out).toEqual({ type: "tool-output-available", toolCallId: "call_1", output: "probe-ran\r\n" });
  });

  it("streams reasoning deltas and closes on item/completed", () => {
    const chunks = run([
      turnStarted,
      { method: "item/reasoning/summaryTextDelta", params: { threadId: TH, itemId: "rs_1", delta: "hmm" } },
      { method: "item/completed", params: { item: { type: "reasoning", id: "rs_1" }, threadId: TH } },
    ]).filter((c) => c.type.startsWith("reasoning"));
    expect(chunks).toEqual([
      { type: "reasoning-start", id: "rs_1" },
      { type: "reasoning-delta", id: "rs_1", delta: "hmm" },
      { type: "reasoning-end", id: "rs_1" },
    ]);
  });

  it("finishes the turn with per-turn usage and the thread id as sessionId", () => {
    const chunks = run([turnStarted, msgDelta("x"), msgCompleted, tokenUsage, turnCompleted("completed")]);
    const finish = chunks.find((c) => c.type === "finish");
    expect(finish.messageMetadata).toMatchObject({
      sessionId: TH, // → metadata.sessionId → thread/resume next session
      resultSubtype: "success",
      inputTokens: 12,
      cacheReadInputTokens: 3,
      outputTokens: 5,
      totalTokens: 17,
      durationMs: 5035,
    });
    expect(chunks.some((c) => c.type === "finish-step")).toBe(true);
  });

  it("surfaces an interrupted turn as its own result subtype (probe P2)", () => {
    const chunks = run([turnStarted, turnCompleted("interrupted")]);
    const finish = chunks.find((c) => c.type === "finish");
    expect(finish.messageMetadata.resultSubtype).toBe("interrupted");
    expect(chunks.some((c) => c.type === "error")).toBe(false); // interrupt is not an error
  });

  it("emits an error before finishing a failed turn", () => {
    const failed = {
      method: "turn/completed",
      params: { threadId: TH, turn: { id: TU, status: "failed", error: { message: "boom" } } },
    };
    const chunks = run([turnStarted, failed]);
    expect(chunks.find((c) => c.type === "error")).toEqual({ type: "error", errorText: "boom" });
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
  });

  it("ignores JSON-RPC responses and server requests (lifecycle traffic)", () => {
    const chunks = run([
      { id: 1, result: { userAgent: "…" } }, // initialize response
      { id: 2, result: { thread: { id: TH } } }, // thread/start response (consumed in Rust)
      { method: "item/commandExecution/requestApproval", id: 0, params: { threadId: TH } }, // server request → transport
    ]);
    expect(chunks.filter((c) => c.type !== "start" && c.type !== "start-step")).toEqual([]);
  });
});
