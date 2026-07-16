// Sidebar.tsx — left nav: logo, actions, screen nav, chat history, user footer.
import { type CSSProperties } from "react";
import { Icon } from "@/shared/ui/Icon";
import { useChatStore } from "@/entities/chat/model/chats";
import { useCodeChatStore } from "@/entities/agent/model/codeChats";
import { ChatGroup, groupHistory, groupByProject, type ScreenId } from "@/app/ui/ChatGroup";
import { UpdateBanner } from "@/widgets/update-banner/ui/UpdateBanner";

const NAV: { id: ScreenId; label: string; icon: string }[] = [
  { id: "providers", label: "Providers", icon: "providers" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "settings", label: "Settings", icon: "cog" },
];

const TOP_ACTIONS: { id: string; label: string; icon: string; primary?: boolean }[] = [
  { id: "new", label: "New chat", icon: "plus", primary: true },
  { id: "search", label: "Search", icon: "search" },
];

// Workspace mode: Chat vs Code. Segmented control at the top of the sidebar (Cowork excluded).
const MODES: { id: ScreenId; label: string; icon: string }[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "code", label: "Code", icon: "code" },
];

function ModeToggle({ mode, setScreen }: { mode: ScreenId; setScreen: (s: ScreenId) => void }) {
  // Highlight follows the sticky workspace mode, so it stays put on overlay screens (Providers/Memory).
  const active = Math.max(0, MODES.findIndex((m) => m.id === mode));
  return (
    <div
      className="mode-seg"
      role="tablist"
      style={{ gridTemplateColumns: `repeat(${MODES.length}, 1fr)`, "--seg-n": MODES.length, "--seg-i": active } as CSSProperties}
    >
      <span className="mode-seg-ind" />
      {MODES.map((m, i) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={mode === m.id}
          className={"mode-seg-btn" + (i === active ? " on" : "")}
          onClick={() => setScreen(m.id)}
        >
          <Icon name={m.icon} size={15} />
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Sidebar({
  screen,
  mode,
  setScreen,
  onNewChat,
  onOpenSearch,
  onCollapse,
  activeChatId,
  onOpenChat,
  onDeleteChat,
  onPinChat,
  onRenameChat,
  activeCodeChatId,
  onOpenCode,
  onDeleteCode,
  onPinCode,
  onRenameCode,
}: {
  screen: ScreenId;
  mode: ScreenId;
  setScreen: (s: ScreenId) => void;
  onNewChat: () => void;
  onOpenSearch: () => void;
  onCollapse: () => void;
  activeChatId: string;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onPinChat: (id: string, pinned: boolean) => void;
  onRenameChat: (id: string, title: string) => void;
  activeCodeChatId: string;
  onOpenCode: (id: string) => void;
  onDeleteCode: (id: string) => void;
  onPinCode: (id: string, pinned: boolean) => void;
  onRenameCode: (id: string, title: string) => void;
}) {
  const { getChats } = useChatStore();
  const { getCodeChats } = useCodeChatStore();
  // Code mode shows its own history + handlers; every other screen shows chat history.
  // Keyed off the sticky mode (not screen) so browsing Providers/Memory keeps the Code workspace.
  const isCode = mode === "code";
  const chats = isCode ? getCodeChats() : getChats();
  const recentsActiveId = isCode ? activeCodeChatId : activeChatId;
  const onOpen = isCode ? onOpenCode : onOpenChat;
  const onDelete = isCode ? onDeleteCode : onDeleteChat;
  const onPin = isCode ? onPinCode : onPinChat;
  const onRename = isCode ? onRenameCode : onRenameChat;
  return (
    <nav className="sidebar">
      <div className="sb-logo" data-tauri-drag-region>
        <span className="sb-mark">
          <svg viewBox="215.04 425.67 211.5 108.83" fill="currentColor" aria-hidden="true">
            <path d="M336.5 516.98C331.04 519.07 315.47 518.72 309.87 516.87C309.87 501.28 309.87 485.7 309.87 470.11C299.78 469.59 289.6 469.95 279.5 469.94C274.4 469.93 268.23 468.96 263.5 470.9C260.98 474.74 261.95 480.01 261.95 484.5C261.95 494.31 263.48 507.08 261.49 516.5C257.25 518.97 240.34 518.76 235.5 517.17C233.63 513.11 234.46 507.96 234.46 503.5C234.46 494.18 232.83 479.07 235.07 470.5C241.08 468.76 256.61 472.09 260.46 467.95C263.99 464.16 260.96 448.85 262.5 443.1C266.13 441.37 270.48 442.01 274.5 442.01C280.06 442.01 285.98 441.33 291.3 443.26C295.72 444.87 298.56 448.46 301.84 451.65C307.92 457.57 313.85 463.66 319.82 469.68C325.33 475.23 334.07 481.23 336.55 488.91C338.12 493.79 337.88 512.05 336.5 516.98ZM411.5 517.21C406.06 518.9 390.09 518.88 385.01 516.5C385.01 500.98 385.01 485.46 385.01 469.94C374.17 469.94 363.34 469.94 352.5 469.93C347.42 469.93 341.68 470.89 337.14 468.5C337.14 460.17 337.14 451.83 337.14 443.5C341.27 441.33 345.89 442.01 350.5 442.01C356.08 442.01 361.79 441.44 367.11 443.44C371.23 444.99 373.98 448.44 377.05 451.45C383.27 457.55 389.38 463.77 395.55 469.94C400.72 475.1 408.2 480.51 411.25 487.27C414.01 493.38 412.88 500.97 412.89 507.5C412.89 510.99 413.41 514.25 411.5 517.21Z" />
          </svg>
        </span>
        <span className="sb-word">Modelius</span>
        <button className="sb-collapse" title="Collapse sidebar" onClick={onCollapse}>
          <Icon name="panelLeftClose" size={16} />
        </button>
      </div>

      <ModeToggle mode={mode} setScreen={setScreen} />

      <div className="sb-group">
        {TOP_ACTIONS.map((a) => (
          <button
            key={a.id}
            className={"sb-row" + (a.primary ? " primary" : "")}
            onClick={() => {
              if (a.id === "new") onNewChat();
              else if (a.id === "search") onOpenSearch();
            }}
          >
            <span className="sb-ic">
              <Icon name={a.icon} size={16} />
            </span>
            <span className="sb-row-label">{a.id === "new" && isCode ? "New session" : a.label}</span>
          </button>
        ))}
      </div>

      <div className="sb-divider" />

      <div className="sb-group">
        {(isCode ? NAV.filter((n) => n.id !== "settings") : NAV).map((n) => (
          <button key={n.id} className={"sb-row" + (screen === n.id ? " on" : "")} onClick={() => setScreen(n.id)}>
            <span className="sb-ic">
              <Icon name={n.icon} size={16} />
            </span>
            <span className="sb-row-label">{n.label}</span>
          </button>
        ))}
      </div>

      <div className="sb-recents">
        <div className="sb-recents-list">
          {(isCode ? groupByProject(chats) : groupHistory(chats)).map((g) => (
            <ChatGroup
              key={g.id}
              group={g}
              activeChatId={recentsActiveId}
              screen={screen}
              onOpenChat={onOpen}
              onDeleteChat={onDelete}
              onPinChat={onPin}
              onRenameChat={onRename}
            />
          ))}
        </div>
      </div>

      <UpdateBanner />

      <div className="sb-user">
        <span className="sb-user-av">TT</span>
        <span className="sb-user-id">
          <span className="sb-user-name">Test Test</span>
          <span className="sb-user-mail">test@gmail.com</span>
        </span>
        <span className="sb-user-acts">
          <button className="sb-user-act" title="Sync">
            <Icon name="upload" size={15} />
          </button>
          <button className="sb-user-act" title="More">
            <Icon name="more" size={15} />
          </button>
        </span>
      </div>
    </nav>
  );
}
