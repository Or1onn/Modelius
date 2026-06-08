// App.tsx — shell: sidebar nav, conversation history, screen routing.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "@/app/styles/styles.css";
import { type PolicyId } from "@/entities/model/model/registry";
import { deleteChat } from "@/entities/chat/model/chats";
import { ChatScreen } from "@/pages/chat/ui/ChatScreen";
import { ProvidersScreen } from "@/pages/providers/ui/ProvidersScreen";
import { MemoryScreen } from "@/pages/memory/ui/MemoryScreen";
import { SearchModal } from "@/widgets/search-modal/ui/SearchModal";
import { Sidebar } from "@/app/ui/Sidebar";
import type { ScreenId } from "@/app/ui/ChatGroup";

// Fixed theme (was the Tweaks panel; now baked-in defaults).
const ROOT_STYLE = {
  "--accent": "#00C9B1",
  "--font-ui": "'Geist', system-ui, sans-serif",
  "--font-mono": "'Geist Mono', monospace",
  "--radius": "14px",
  "--su": 1,
  "--grain-op": (25 / 100) * 0.55,
} as CSSProperties;

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("chat");
  const [policy, setPolicy] = useState<PolicyId>("cost");
  const [searchOpen, setSearchOpen] = useState(false);

  // Chat session: activeChatId keys ChatScreen, so switching/opening remounts it with
  // the target chat's state (loaded from storage on mount; persisted as it changes).
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID());
  const startupChatId = useRef(activeChatId); // the demo thread only ever seeds this chat

  const newChat = () => {
    setActiveChatId(crypto.randomUUID());
    setScreen("chat");
  };
  const openChat = (id: string) => {
    setActiveChatId(id);
    setScreen("chat");
    setSearchOpen(false);
  };
  const removeChat = (id: string) => {
    deleteChat(id);
    if (id === activeChatId) setActiveChatId(crypto.randomUUID());
  };

  // Cmd/Ctrl-K toggles search (shortcut freed up after removing the Tweaks panel).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.6 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

  return (
    <div className="app" style={ROOT_STYLE}>
      <div className="grain" style={{ backgroundImage: noise, opacity: "var(--grain-op)" }} />
      <Sidebar
        screen={screen}
        setScreen={setScreen}
        onNewChat={newChat}
        onOpenSearch={() => setSearchOpen(true)}
        activeChatId={activeChatId}
        onOpenChat={openChat}
        onDeleteChat={removeChat}
      />
      <main className="stage">
        {screen === "chat" && (
          <ChatScreen
            key={activeChatId}
            chatId={activeChatId}
            showDemo={activeChatId === startupChatId.current}
            policy={policy}
            setPolicy={setPolicy}
          />
        )}
        {screen === "providers" && <ProvidersScreen />}
        {screen === "memory" && <MemoryScreen />}
      </main>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onOpenChat={openChat} />
    </div>
  );
}
