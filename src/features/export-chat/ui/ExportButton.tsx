// ExportButton.tsx — header affordance: copy/save the current chat as Markdown or JSON.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import type { Message } from "@/entities/model/model/registry";
import { toMarkdown, toJSON } from "../model/serialize";
import { copyToClipboard, saveToFile } from "../lib/save";

function safeName(title: string, ext: string): string {
  // Keep the chat title as the filename (Cyrillic/spaces included); strip only
  // filesystem-invalid chars, collapse whitespace, drop a trailing dot/space (Windows).
  const base =
    (title || "chat")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "")
      .slice(0, 80)
      .trim() || "chat";
  return `${base}.${ext}`;
}

export function ExportButton({ title, messages, createdAt }: { title: string; messages: Message[]; createdAt?: number }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const meta = { title, createdAt };
  const act = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    try {
      const ok = await fn();
      if (ok !== false) {
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }
    } catch {
      /* cancelled or clipboard/permission denied */
    }
  };

  return (
    <div className="export-wrap" ref={ref}>
      <button className="icon-btn" title="Export chat" onClick={() => setOpen((v) => !v)} disabled={messages.length === 0}>
        <Icon name={done ? "check" : "upload"} size={15} />
      </button>
      {open && (
        <div className="export-menu">
          <button className="export-item" onClick={() => act(() => copyToClipboard(toMarkdown(messages, meta)))}>
            <Icon name="copy" size={14} /> Copy (Markdown)
          </button>
          <button className="export-item" onClick={() => act(() => copyToClipboard(toJSON(messages, meta)))}>
            <Icon name="copy" size={14} /> Copy (JSON)
          </button>
          <button className="export-item" onClick={() => act(() => saveToFile(toMarkdown(messages, meta), safeName(title, "md")))}>
            <Icon name="upload" size={14} /> Save .md
          </button>
          <button className="export-item" onClick={() => act(() => saveToFile(toJSON(messages, meta), safeName(title, "json")))}>
            <Icon name="upload" size={14} /> Save .json
          </button>
        </div>
      )}
    </div>
  );
}
