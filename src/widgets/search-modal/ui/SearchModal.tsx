// SearchModal.tsx — ⌘K palette: chats by title/preview (instant) + full-text messages (lazy).
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { getChats, loadChatBody } from "@/entities/chat/model/chats";
import type { Message } from "@/entities/model/model/registry";
import { matches, snippet } from "@/features/search-chats/lib/search";

type Snip = { before: string; match: string; after: string };
type Result = { id: string; title: string; snip: Snip | null };

export function SearchModal({
  open,
  onClose,
  onOpenChat,
}: {
  open: boolean;
  onClose: () => void;
  onOpenChat: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0); // bump to recompute once bodies arrive
  const bodies = useRef<Map<string, Message[]>>(new Map()); // chatId → messages (full-text cache)
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // On open: reset, focus, lazily load every chat body once for content search.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    inputRef.current?.focus();
    // Only load uncached bodies (picks up chats added since last open).
    const missing = getChats().map((c) => c.id).filter((id) => !bodies.current.has(id));
    if (missing.length === 0) return;
    setLoading(true);
    Promise.all(
      missing.map(async (id) => {
        const body = await loadChatBody(id);
        if (body) bodies.current.set(id, body.messages);
      })
    ).then(() => {
      setLoading(false);
      setTick((t) => t + 1);
    });
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim();
    const chats = getChats();
    if (!q) return chats.slice(0, 8).map((c) => ({ id: c.id, title: c.title, snip: null }));
    const out: Result[] = [];
    for (const c of chats) {
      if (matches(c.title, q) || matches(c.preview, q)) {
        out.push({ id: c.id, title: c.title, snip: null });
        continue;
      }
      const msgs = bodies.current.get(c.id);
      if (!msgs) continue;
      let snip: Snip | null = null;
      for (const m of msgs) {
        snip = snippet(m.text, q);
        if (snip) break;
      }
      if (snip) out.push({ id: c.id, title: c.title, snip });
    }
    return out;
    // tick re-runs this once async bodies land in the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tick]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".search-result.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      const r = results[sel];
      if (r) onOpenChat(r.id);
    }
  };

  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-box">
        <div className="search-input-row">
          <Icon name="search" size={16} style={{ color: "var(--text-3)" }} />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="search-hint">esc</span>
        </div>
        <div className="search-results" ref={listRef}>
          {results.length === 0 ? (
            <div className="search-empty">
              {query.trim() ? (loading ? "Searching…" : "No matches") : "No chats yet"}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                className={"search-result" + (i === sel ? " on" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => onOpenChat(r.id)}
              >
                <div className="search-result-main">
                  <div className="search-result-title">{r.title}</div>
                  {r.snip && (
                    <div className="search-snippet">
                      {r.snip.before}
                      <mark>{r.snip.match}</mark>
                      {r.snip.after}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
