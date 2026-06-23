// ChatGroup.tsx — collapsible sidebar date-group + the bucketing helper and shared ScreenId.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const pinned: ChatIndexEntry[] = [];
  const today: ChatIndexEntry[] = [], yesterday: ChatIndexEntry[] = [], earlier: ChatIndexEntry[] = [];
  for (const c of chats) {
    if (c.pinned) pinned.push(c);
    else if (c.updatedAt >= todayMs) today.push(c);
    else if (c.updatedAt >= yestMs) yesterday.push(c);
    else earlier.push(c);
  }
  return [
    { id: "pinned", label: "Pinned", items: pinned, defaultOpen: true },
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
  onPinChat,
  onRenameChat,
}: {
  group: HistGroup;
  activeChatId: string;
  screen: ScreenId;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onPinChat: (id: string, pinned: boolean) => void;
  onRenameChat: (id: string, title: string) => void;
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
        {group.items.map((h) => (
          <ChatRow
            key={h.id}
            chat={h}
            active={h.id === activeChatId && screen === "chat"}
            onOpenChat={onOpenChat}
            onDeleteChat={onDeleteChat}
            onPinChat={onPinChat}
            onRenameChat={onRenameChat}
          />
        ))}
      </div>
    </div>
  );
}

// A single chat row: title (or inline rename input) + a three-dots actions menu.
function ChatRow({
  chat,
  active,
  onOpenChat,
  onDeleteChat,
  onPinChat,
  onRenameChat,
}: {
  chat: ChatIndexEntry;
  active: boolean;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onPinChat: (id: string, pinned: boolean) => void;
  onRenameChat: (id: string, title: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom });
  };

  const startRename = () => {
    setMenu(null);
    setDraft(chat.title);
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== chat.title) onRenameChat(chat.id, draft.trim());
  };

  return (
    <div className={"sb-chat" + (active ? " on" : "")} onClick={() => !renaming && onOpenChat(chat.id)}>
      {renaming ? (
        <input
          ref={inputRef}
          className="sb-chat-rename"
          value={draft}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <span className="sb-chat-title">{chat.title}</span>
      )}
      <button className="sb-chat-more" title="More" onClick={openMenu}>
        <Icon name="more" size={15} />
      </button>
      {menu && (
        <ChatMenu
          x={menu.x}
          y={menu.y}
          pinned={!!chat.pinned}
          onClose={() => setMenu(null)}
          onPin={() => {
            setMenu(null);
            onPinChat(chat.id, !chat.pinned);
          }}
          onRename={startRename}
          onDelete={() => {
            setMenu(null);
            onDeleteChat(chat.id);
          }}
        />
      )}
    </div>
  );
}

// Portaled, fixed-positioned popover so it escapes the scroll container's clipping.
function ChatMenu({
  x,
  y,
  pinned,
  onClose,
  onPin,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  pinned: boolean;
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip left/up if the menu would overflow the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: x - width > 8 ? x - width : x,
      top: y + height > window.innerHeight - 8 ? y - height - 28 : y + 4,
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="sb-chat-menu"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="sb-chat-menu-item" onClick={onPin}>
        <Icon name="pin" size={14} />
        {pinned ? "Открепить" : "Закрепить"}
      </button>
      <button className="sb-chat-menu-item" onClick={onRename}>
        <Icon name="edit" size={14} />
        Переименовать
      </button>
      <button className="sb-chat-menu-item danger" onClick={onDelete}>
        <Icon name="trash" size={14} />
        Удалить
      </button>
    </div>,
    document.body
  );
}
