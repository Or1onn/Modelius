// ChatGroup.tsx — collapsible sidebar date-group + the bucketing helper and shared ScreenId.
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import type { ChatIndexEntry } from "@/entities/chat/model/chats";

export type ScreenId = "chat" | "providers" | "memory";

// Bucket chats by updatedAt into Today/Yesterday/Earlier (local day). Empty groups dropped by ChatGroup.
export type HistGroup = { id: string; label: string; items: ChatIndexEntry[]; defaultOpen: boolean };

export function groupHistory(chats: ChatIndexEntry[]): HistGroup[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yestMs = todayMs - 86_400_000;
  const today: ChatIndexEntry[] = [], yesterday: ChatIndexEntry[] = [], earlier: ChatIndexEntry[] = [];
  for (const c of chats) {
    if (c.updatedAt >= todayMs) today.push(c);
    else if (c.updatedAt >= yestMs) yesterday.push(c);
    else earlier.push(c);
  }
  return [
    { id: "today", label: "Today", items: today, defaultOpen: true },
    { id: "yesterday", label: "Yesterday", items: yesterday, defaultOpen: false },
    { id: "earlier", label: "Earlier", items: earlier, defaultOpen: false },
  ];
}

// Collapsible date group of chats.
export function ChatGroup({
  group,
  activeChatId,
  screen,
  onOpenChat,
  onDeleteChat,
}: {
  group: HistGroup;
  activeChatId: string;
  screen: ScreenId;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(group.defaultOpen);
  if (!group.items.length) return null;
  return (
    <div className="sb-cg">
      <button className="sb-cg-head" onClick={() => setOpen((v) => !v)}>
        <span className={"sb-cg-chev" + (open ? " open" : "")}>
          <Icon name="chevronD" size={12} />
        </span>
        <span className="sb-cg-label">{group.label}</span>
        <span className="sb-cg-count">{group.items.length}</span>
      </button>
      <div className={"sb-cg-items" + (open ? " open" : "")}>
        <span className="sb-cg-line" />
        {group.items.map((h) => {
          const active = h.id === activeChatId && screen === "chat";
          return (
            <div key={h.id} className={"sb-chat" + (active ? " on" : "")} onClick={() => onOpenChat(h.id)}>
              <span className="sb-chat-title">{h.title}</span>
              <button
                className="sb-chat-more"
                title="Delete chat"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteChat(h.id);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
