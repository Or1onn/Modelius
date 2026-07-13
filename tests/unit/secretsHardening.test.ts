import { describe, it, expect, beforeEach, vi } from "vitest";

// Simulate the Tauri environment with a controllable keychain/vault so we can exercise the
// failure paths that used to lose secrets / clobber real data.
vi.mock("@/shared/api/tauri", () => ({ isTauri: () => true }));

let vaultUp = true;
let keychainSetOk = true;
const invokeMock = vi.fn(async (cmd: string, args: { key?: string; plaintext?: string; blob?: string }) => {
  switch (cmd) {
    case "secret_set":
      if (!keychainSetOk) throw new Error("keychain unavailable");
      return;
    case "secret_delete":
      return;
    case "vault_encrypt":
      return "v1:" + args.plaintext;
    case "vault_decrypt":
      if (!vaultUp) throw new Error("keychain locked");
      return String(args.blob).replace(/^v1:/, ""); // fake decrypt: strip the version tag
    default:
      return null;
  }
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args as never),
}));

import { secretSet } from "@/shared/api/secrets";
import { makeChatIndexStore } from "@/entities/chat/model/chats";

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
  vaultUp = true;
  keychainSetOk = true;
});

describe("secretSet never loses a value", () => {
  it("keeps the value in the encrypted overflow when the keychain set fails", async () => {
    keychainSetOk = false;
    const ok = await secretSet("modelius.key.test", "sk-123");
    expect(ok).toBe(true);
    expect(localStorage.getItem("modelius.secret.modelius.key.test")).toBe("v1:sk-123");
    // the stale keychain entry is cleared only AFTER the overflow is safely written
    expect(invokeMock).toHaveBeenCalledWith("secret_delete", { key: "modelius.key.test" });
  });

  it("returns false and does NOT delete the keychain entry when nothing can be stored", async () => {
    keychainSetOk = false;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const ok = await secretSet("modelius.key.test", "sk-123");
    spy.mockRestore();
    expect(ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("secret_delete", { key: "modelius.key.test" });
  });
});

describe("index hydrate never clobbers real data on a transient vault failure", () => {
  const real = [{ id: "real1", title: "R", modelId: "", preview: "", createdAt: 1, updatedAt: 1 }];
  const REAL_BLOB = "v1:" + JSON.stringify(real);

  it("skips persist while decrypt fails, leaving the stored index intact, then recovers", async () => {
    localStorage.setItem("t.h.idx", REAL_BLOB);
    vaultUp = false;
    const s = makeChatIndexStore("t.h.idx", "t.h.evt", async () => {});

    await s.hydrate();
    expect(s.getAll()).toHaveLength(0); // decrypt failed → not loaded (but not latched empty)

    // A user action must NOT persist an empty index over the real (still-encrypted) blob.
    s.upsert({ id: "new1", title: "N", modelId: "", preview: "", createdAt: 2, updatedAt: 2 });
    expect(localStorage.getItem("t.h.idx")).toBe(REAL_BLOB);

    // Vault recovers → a later hydrate loads the real data.
    vaultUp = true;
    await new Promise((r) => setTimeout(r, 0)); // let the retry kicked by save() settle
    await s.hydrate();
    expect(s.getAll().map((c) => c.id)).toContain("real1");
  });

  it("latches empty (and does not throw) when the decrypted content is genuinely corrupt", async () => {
    localStorage.setItem("t.c.idx", "v1:not json at all");
    const s = makeChatIndexStore("t.c.idx", "t.c.evt", async () => {});
    await s.hydrate();
    expect(s.getAll()).toHaveLength(0);
    // hydrated latched → a subsequent save persists normally (over the unrecoverable blob)
    s.upsert({ id: "x", title: "x", modelId: "", preview: "", createdAt: 1, updatedAt: 1 });
    await new Promise((r) => setTimeout(r, 0)); // the store persists on a microtask
    expect(localStorage.getItem("t.c.idx")).not.toBe("v1:not json at all");
  });
});
