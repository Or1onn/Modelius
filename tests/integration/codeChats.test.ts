import { describe, it, expect, beforeEach } from "vitest";
import { saveCodeBody, loadCodeBody, type CodeChatBody } from "@/entities/agent/model/codeChats";

// Off-Tauri the vault degrades to identity and bodies persist to localStorage (see chats.test.ts).
beforeEach(() => localStorage.clear());

const body = (over: Partial<CodeChatBody> = {}): CodeChatBody => ({
  steps: [{ type: "user", text: "hi" }],
  cwd: "D:\\proj",
  harnessId: "claude-code",
  modelId: "claude-opus-4-8",
  permissionMode: "acceptEdits",
  title: "t",
  ...over,
});

describe("code chat body", () => {
  it("roundtrips resumeId and last-run stats", async () => {
    await saveCodeBody("c1", body({ resumeId: "sess-9", contextTokens: 1234, cost: 0.05 }));
    const b = await loadCodeBody("c1");
    expect(b?.resumeId).toBe("sess-9");
    expect(b?.contextTokens).toBe(1234);
    expect(b?.cost).toBe(0.05);
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
