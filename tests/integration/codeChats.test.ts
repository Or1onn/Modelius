import { describe, it, expect, beforeEach } from "vitest";
import type { UIMessage } from "ai";
import { saveCodeBody, loadCodeBody, type CodeChatBody } from "@/entities/agent/model/codeChats";

// Off-Tauri the vault degrades to identity and bodies persist to localStorage (see chats.test.ts).
beforeEach(() => localStorage.clear());

const msgs: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
const body = (over: Partial<CodeChatBody> = {}): CodeChatBody => ({
  messages: msgs,
  cwd: "D:\\proj",
  harnessId: "claude-code",
  modelId: "claude-opus-4-8",
  permissionMode: "acceptEdits",
  title: "t",
  ...over,
});

describe("code chat body", () => {
  it("roundtrips the message transcript and config", async () => {
    await saveCodeBody("c1", body({ cwd: "D:\\x" }));
    const b = await loadCodeBody("c1");
    expect(b?.messages).toHaveLength(1);
    expect(b?.messages[0].role).toBe("user");
    expect(b?.cwd).toBe("D:\\x");
  });

  it("drops a legacy (pre-AI-SDK) `steps` body as unrecognized", async () => {
    // Simulate an old body that stored `steps` instead of `messages`.
    await saveCodeBody("c-legacy", { steps: [{ type: "user", text: "hi" }] } as unknown as CodeChatBody);
    expect(await loadCodeBody("c-legacy")).toBeNull();
  });

  it("migrates the retired 'default' permission mode to acceptEdits", async () => {
    await saveCodeBody("c2", body({ permissionMode: "default" }));
    expect((await loadCodeBody("c2"))?.permissionMode).toBe("acceptEdits");
  });

  it("keeps a live permission mode as-is and defaults a missing one", async () => {
    await saveCodeBody("c3", body({ permissionMode: "plan" }));
    expect((await loadCodeBody("c3"))?.permissionMode).toBe("plan");
    await saveCodeBody("c4", { ...body(), permissionMode: undefined as unknown as string });
    expect((await loadCodeBody("c4"))?.permissionMode).toBe("acceptEdits");
  });
});
