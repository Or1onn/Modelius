// Sidebar.tsx — left nav: logo, top actions (new chat / search), screen nav,
// grouped conversation history, and the user footer.
import { Icon } from "@/shared/ui/Icon";
import { useChatStore } from "@/entities/chat/model/chats";
import { ChatGroup, groupHistory, type ScreenId } from "@/app/ui/ChatGroup";

const NAV: { id: ScreenId; label: string; icon: string; beta?: boolean }[] = [
  { id: "providers", label: "Providers", icon: "providers" },
  { id: "memory", label: "Memory", icon: "memory" },
];

const TOP_ACTIONS: { id: string; label: string; icon: string; primary?: boolean }[] = [
  { id: "new", label: "New chat", icon: "plus", primary: true },
  { id: "search", label: "Search", icon: "search" },
];

export function Sidebar({
  screen,
  setScreen,
  onNewChat,
  onOpenSearch,
  activeChatId,
  onOpenChat,
  onDeleteChat,
}: {
  screen: ScreenId;
  setScreen: (s: ScreenId) => void;
  onNewChat: () => void;
  onOpenSearch: () => void;
  activeChatId: string;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
}) {
  const { getChats } = useChatStore();
  const chats = getChats();
  return (
    <nav className="sidebar">
      <div className="sb-logo">
        <span className="sb-mark">
          <span className="sb-mark-core" />
        </span>
        <span className="sb-word">Orchestro</span>
        <button className="sb-collapse" title="Collapse sidebar">
          <Icon name="providers" size={15} />
        </button>
      </div>

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
            <span className="sb-row-label">{a.label}</span>
          </button>
        ))}
      </div>

      <div className="sb-divider" />

      <div className="sb-group">
        {NAV.map((n) => (
          <button key={n.id} className={"sb-row" + (screen === n.id ? " on" : "")} onClick={() => setScreen(n.id)}>
            <span className="sb-ic">
              <Icon name={n.icon} size={16} />
            </span>
            <span className="sb-row-label">{n.label}</span>
            {n.beta && <span className="sb-beta">BETA</span>}
          </button>
        ))}
      </div>

      <div className="sb-recents">
        <div className="sb-recents-list">
          {groupHistory(chats).map((g) => (
            <ChatGroup
              key={g.id}
              group={g}
              activeChatId={activeChatId}
              screen={screen}
              onOpenChat={onOpenChat}
              onDeleteChat={onDeleteChat}
            />
          ))}
        </div>
      </div>

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
