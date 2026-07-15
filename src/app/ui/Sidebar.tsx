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
          <span className="sb-mark-core" />
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
