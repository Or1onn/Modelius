import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/api/tauri", () => ({ isTauri: () => true }));

// In-memory keychain; secretSet fails for groq to exercise the "don't drop on failed store" path.
const kc: Record<string, string> = {};
const setMock = vi.fn(async (k: string, v: string) => {
  if (k.endsWith(".groq")) return false; // simulate a store that couldn't persist
  kc[k] = v;
  return true;
});
vi.mock("@/shared/api/secrets", () => ({
  secretGet: vi.fn(async (k: string) => kc[k] ?? null),
  secretSet: (k: string, v: string) => setMock(k, v),
}));

import { migrateToSecureStorage } from "@/shared/lib/migrateSecrets";

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(kc)) delete kc[k];
  setMock.mockClear();
});

describe("secret migration", () => {
  it("migrates the openrouter key and never drops a key whose store failed", async () => {
    localStorage.setItem("modelius.key.openrouter", "sk-or-abc123");
    localStorage.setItem("modelius.key.groq", "gsk_failstore");

    await migrateToSecureStorage();

    // openrouter (previously omitted from the migration list) is moved and the plaintext cleared
    expect(kc["modelius.key.openrouter"]).toBe("sk-or-abc123");
    expect(localStorage.getItem("modelius.key.openrouter")).toBeNull();

    // groq's store failed → the plaintext original is preserved, not deleted
    expect(localStorage.getItem("modelius.key.groq")).toBe("gsk_failstore");
  });
});
