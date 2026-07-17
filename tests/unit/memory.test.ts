import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake vault: reversible "enc:" wrapper, or hard failure when down. Characterizes the
// hydrate/persist latch that guards real memory from being clobbered while the vault is out.
const vault = vi.hoisted(() => ({ down: false }));
vi.mock("@/shared/api/secrets", () => ({
  vaultEncrypt: async (s: string) => {
    if (vault.down) throw new Error("vault unavailable");
    return "enc:" + s;
  },
  vaultDecrypt: async (s: string) => {
    if (vault.down) throw new Error("vault unavailable");
    return s.slice(4);
  },
}));

const KEY = "modelius.memory";
type Mem = typeof import("@/entities/memory/model/memory");

// Fresh module per test — the store keeps its cache/hydrated latch at module scope.
async function freshMemory(): Promise<Mem> {
  vi.resetModules();
  return import("@/entities/memory/model/memory");
}

beforeEach(() => {
  localStorage.clear();
  vault.down = false;
});

describe("memory store (vault-backed)", () => {
  it("hydrates an encrypted blob and builds the injectable block", async () => {
    const facts = [{ id: "1", text: "Likes Rust", kind: "preference", enabled: true, createdAt: 1 }];
    localStorage.setItem(KEY, "enc:" + JSON.stringify(facts));
    const mem = await freshMemory();
    await mem.hydrateMemory();
    expect(mem.getMemories()).toHaveLength(1);
    expect(mem.memoryBlock()).toContain("Likes Rust");
  });

  it("addMemory dedups case/space-insensitively and persists encrypted", async () => {
    const mem = await freshMemory();
    await mem.hydrateMemory(); // no blob → latches hydrated
    expect(mem.addMemory("Likes Rust", "preference")).toBe(true);
    expect(mem.addMemory("  likes   rust ")).toBe(false); // duplicate
    await vi.waitFor(() => {
      const raw = localStorage.getItem(KEY);
      expect(raw).toMatch(/^enc:/);
      expect(raw).toContain("Likes Rust");
    });
  });

  it("does not clobber the stored blob while the vault is down", async () => {
    const original = "enc:" + JSON.stringify([{ id: "1", text: "real fact", kind: "fact", enabled: true, createdAt: 1 }]);
    localStorage.setItem(KEY, original);
    vault.down = true;
    const mem = await freshMemory();
    await mem.hydrateMemory(); // decrypt fails → hydrated NOT latched
    expect(mem.getMemories()).toHaveLength(0);
    mem.addMemory("new fact"); // save() must skip persistence pre-hydration
    await new Promise((r) => setTimeout(r, 10));
    expect(localStorage.getItem(KEY)).toBe(original); // real data untouched
    expect(mem.getMemories().map((m) => m.text)).toContain("new fact"); // RAM still updated
  });

  it("applyMemoryOps collapses a near-duplicate add into an update", async () => {
    const mem = await freshMemory();
    await mem.hydrateMemory();
    mem.addMemory("user likes rust programming", "preference");
    const id = mem.getMemories()[0].id;
    const changed = mem.applyMemoryOps([
      { op: "add", text: "user likes rust programming a lot", kind: "preference" }, // near-dup → update
      { op: "delete", id: "missing" }, // unknown id → no-op
    ]);
    expect(changed).toEqual(["user likes rust programming a lot"]);
    const list = mem.getMemories();
    expect(list).toHaveLength(1); // updated in place, not appended
    expect(list[0].id).toBe(id);
    expect(list[0].text).toBe("user likes rust programming a lot");
  });
});
