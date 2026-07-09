import { describe, it, expect, beforeEach } from "vitest";
import {
  makeChatIndexStore,
  makeBodyStore,
  indexEntryFrom,
  saveChatBody,
  loadChatBody,
  type ChatIndexEntry,
} from "@/entities/chat/model/chats";
import type { Message } from "@/entities/model/model/registry";

// Off-Tauri, isTauri() is false → vault encrypt/decrypt degrade to identity and everything
// persists to localStorage, so the whole store runs in jsdom with no Tauri mocking.
beforeEach(() => localStorage.clear());

const entry = (id: string, over: Partial<ChatIndexEntry> = {}): ChatIndexEntry => ({
  id, title: id, modelId: "", preview: "", createdAt: 1, updatedAt: 1, ...over,
});

describe("chat index store", () => {
  it("upserts and returns entries newest-first", () => {
    const s = makeChatIndexStore("t.idx1", "t.evt1", async () => {});
    s.upsert(entry("a", { updatedAt: 100 }));
    s.upsert(entry("b", { updatedAt: 200 }));
    expect(s.getAll().map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("keeps a renamed title sticky against a later content upsert", () => {
    const s = makeChatIndexStore("t.idx2", "t.evt2", async () => {});
    s.upsert(entry("a", { title: "auto" }));
    s.rename("a", "My Name");
    s.upsert(entry("a", { title: "auto-regenerated", updatedAt: 5 }));
    expect(s.getAll()[0].title).toBe("My Name");
  });

  it("pins and deletes, invoking the body deleter", () => {
    const deleted: string[] = [];
    const s = makeChatIndexStore("t.idx3", "t.evt3", async (id) => { deleted.push(id); });
    s.upsert(entry("a"));
    s.pin("a", true);
    expect(s.getAll()[0].pinned).toBe(true);
    s.del("a");
    expect(s.getAll()).toHaveLength(0);
    expect(deleted).toEqual(["a"]);
  });

  it("dispatches the change event on write", () => {
    const s = makeChatIndexStore("t.idx4", "t.evt4", async () => {});
    let fired = 0;
    const h = () => { fired++; };
    window.addEventListener("t.evt4", h);
    s.upsert(entry("a"));
    window.removeEventListener("t.evt4", h);
    expect(fired).toBeGreaterThan(0);
  });
});

describe("chat body store", () => {
  it("roundtrips a saved body and deletes it", async () => {
    const b = makeBodyStore("t.body.");
    await b.save("x", { hello: "world", n: 1 });
    expect(await b.load("x")).toEqual({ hello: "world", n: 1 });
    await b.del("x");
    expect(await b.load("x")).toBeNull();
  });
});

describe("saveChatBody / loadChatBody", () => {
  it("strips transient streaming state, folding shown into text", async () => {
    const messages: Message[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "", shown: "partial answer", streaming: true },
    ];
    await saveChatBody("s1", { messages, summary: "", covered: 0, title: "" });
    const loaded = await loadChatBody("s1");
    expect(loaded).not.toBeNull();
    const asst = loaded!.messages[1];
    expect(asst.text).toBe("partial answer");
    expect(asst.streaming).toBeUndefined();
    expect((asst as { shown?: string }).shown).toBeUndefined();
  });
});

describe("indexEntryFrom", () => {
  const u = (text: string): Message => ({ role: "user", text });
  const a = (text: string): Message => ({ role: "assistant", text });

  it("returns null when there is no user message", () => {
    expect(indexEntryFrom("id", [a("hello")], 0)).toBeNull();
  });

  it("uses 'New chat' until settled, then the first user message", () => {
    expect(indexEntryFrom("id", [u("Explain quantum")], 0, undefined, false)?.title).toBe("New chat");
    expect(indexEntryFrom("id", [u("Explain quantum")], 0, undefined, true)?.title).toBe("Explain quantum");
  });

  it("prefers an explicit title and takes modelId from the last assistant", () => {
    const msgs: Message[] = [
      u("q"),
      { role: "assistant", text: "a", decision: { chosen: { id: "gpt-4o" } } as Message["decision"] },
    ];
    const e = indexEntryFrom("id", msgs, 0, "  Custom  ");
    expect(e?.title).toBe("Custom");
    expect(e?.modelId).toBe("gpt-4o");
  });
});
