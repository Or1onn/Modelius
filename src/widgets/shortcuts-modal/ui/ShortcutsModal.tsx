// ShortcutsModal.tsx — keyboard shortcuts cheatsheet. Mirrors SearchModal's overlay pattern.
import { useEffect } from "react";

// (keys, description). `mod` renders as a "Ctrl / Cmd" chip.
const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["mod", "K"], label: "Search chats" },
  { keys: ["mod", "N"], label: "New chat" },
  { keys: ["mod", "/"], label: "Show shortcuts" },
  { keys: ["Enter"], label: "Send message" },
  { keys: ["Shift", "Enter"], label: "New line" },
  { keys: ["Esc"], label: "Close dialog / cancel edit" },
];

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcuts-box">
        <div className="shortcuts-head">
          <span>Keyboard shortcuts</span>
          <span className="search-hint">esc</span>
        </div>
        <div className="shortcuts-list">
          {SHORTCUTS.map((s, i) => (
            <div className="shortcuts-row" key={i}>
              <span className="shortcuts-label">{s.label}</span>
              <span className="shortcuts-keys">
                {s.keys.map((k, j) => (
                  <kbd className="kbd" key={j}>
                    {k === "mod" ? "Ctrl / Cmd" : k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
