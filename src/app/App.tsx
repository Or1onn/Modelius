// App.tsx — shell: sidebar nav, conversation history, screen routing.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "@/app/styles/styles.css";
import { type PolicyId } from "@/entities/model/model/registry";
import { deleteChat, hydrateChatIndex } from "@/entities/chat/model/chats";
import { dropSession, isEmptySession } from "@/pages/chat/model/sessionStore";
import { listOllamaModels } from "@/entities/session/model/ollamaSession";
import { hasKey } from "@/entities/session/model/keys";
import { KEY_PROVIDER_IDS, listKeyProviderModels } from "@/entities/session/model/keyProviders";
import { loadDynamicPricing } from "@/entities/model/lib/pricingSource";
import { hydrateMemory } from "@/entities/memory/model/memory";
import { hydrateTitles } from "@/entities/artifact/model/artifacts";
import { migrateToSecureStorage } from "@/shared/lib/migrateSecrets";
import { clearDraft } from "@/pages/chat/model/drafts";
import { ChatScreen } from "@/pages/chat/ui/ChatScreen";
import { ProvidersScreen } from "@/pages/providers/ui/ProvidersScreen";
import { MemoryScreen } from "@/pages/memory/ui/MemoryScreen";
import { SearchModal } from "@/widgets/search-modal/ui/SearchModal";
import { Sidebar } from "@/app/ui/Sidebar";
import { Icon } from "@/shared/ui/Icon";
import type { ScreenId } from "@/app/ui/ChatGroup";

// Fixed theme (baked-in defaults).
const ROOT_STYLE = {
  "--accent": "#00C9B1",
  "--font-ui": "'Geist', system-ui, sans-serif",
  "--font-mono": "'Geist Mono', monospace",
  "--su": 1,
  "--grain-op": (25 / 100) * 0.55,
} as CSSProperties;

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("chat");
  const [policy] = useState<PolicyId>("cost");
  const [searchOpen, setSearchOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);

  // activeChatId keys ChatScreen, so switching/opening remounts it with that chat's state.
  const [activeChatId, setActiveChatId] = useState<string>(() => crypto.randomUUID());
  const startupChatId = useRef(activeChatId); // demo thread only seeds this chat
  // The pending "new chat" slot, stable across visits to existing chats so its unsent draft survives.
  const [newChatId, setNewChatId] = useState(activeChatId);

  // Switch to the pending new chat, spinning a fresh one only once the current slot has messages.
  const gotoNewChat = (): string => {
    let id = newChatId;
    if (!isEmptySession(id)) {
      id = crypto.randomUUID();
      setNewChatId(id);
    }
    setActiveChatId(id);
    return id;
  };

  const newChat = () => {
    gotoNewChat();
    setScreen("chat");
  };
  const openChat = (id: string) => {
    setActiveChatId(id);
    setScreen("chat");
    setSearchOpen(false);
  };
  const removeChat = (id: string) => {
    deleteChat(id);
    dropSession(id); // drop live session so a stray commit can't resurrect the chat
    clearDraft(id);
    if (id === activeChatId) gotoNewChat(); // fall back to the new-chat slot
  };

  // Startup: migrate secrets into the keychain, decrypt the in-RAM stores, then warm live
  // model lists so connected providers join the routing pool before the picker opens.
  useEffect(() => {
    void (async () => {
      await migrateToSecureStorage();
      await Promise.all([hydrateMemory(), hydrateChatIndex(), hydrateTitles()]);
      void loadDynamicPricing(); // live per-token prices (OpenRouter) → routing cost + real $ per turn
      void listOllamaModels().catch(() => {});
      for (const pid of KEY_PROVIDER_IDS) if (hasKey(pid)) void listKeyProviderModels(pid).catch(() => {});
    })();
  }, []);

  // Cmd/Ctrl-K toggles search.
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
    <div className={"app" + (navCollapsed ? " nav-collapsed" : "")} style={ROOT_STYLE}>
      <div className="grain" style={{ backgroundImage: noise, opacity: "var(--grain-op)" }} />
      <Sidebar
        screen={screen}
        setScreen={setScreen}
        onNewChat={newChat}
        onOpenSearch={() => setSearchOpen(true)}
        onCollapse={() => setNavCollapsed(true)}
        activeChatId={activeChatId}
        onOpenChat={openChat}
        onDeleteChat={removeChat}
      />
      {navCollapsed && (
        <button className="sb-reopen" title="Show sidebar" onClick={() => setNavCollapsed(false)}>
          <Icon name="panelLeftOpen" size={16} />
        </button>
      )}
      <main className="stage">
        {/* Streaming lives in the session store, so a screen switch unmount doesn't abort it. */}
        {screen === "chat" && (
          <ChatScreen
            key={activeChatId}
            chatId={activeChatId}
            showDemo={activeChatId === startupChatId.current}
            policy={policy}
          />
        )}
        {screen === "providers" && <ProvidersScreen />}
        {screen === "memory" && <MemoryScreen />}
      </main>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onOpenChat={openChat} />
    </div>
  );
}
