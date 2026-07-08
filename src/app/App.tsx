// App.tsx — shell: sidebar nav, conversation history, screen routing.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "highlight.js/styles/github-dark.css";
import "@/app/styles/styles.css";
import { hydrateSettings, useSettings } from "@/entities/settings/model/settings";
import { deleteChat, pinChat, renameChat, hydrateChatIndex } from "@/entities/chat/model/chats";
import { deleteCodeChat, pinCodeChat, renameCodeChat, hydrateCodeIndex } from "@/entities/agent/model/codeChats";
import { dropSession, isEmptySession } from "@/pages/chat/model/sessionStore";
import { dropCodeSession, isEmptyCodeSession } from "@/pages/code/model/codeSessionStore";
import { listOllamaModels } from "@/entities/session/model/ollamaSession";
import { hasKey } from "@/entities/session/model/keys";
import { KEY_PROVIDER_IDS, listKeyProviderModels } from "@/entities/session/model/keyProviders";
import { loadDynamicPricing } from "@/entities/model/lib/pricingSource";
import { hydrateMemory } from "@/entities/memory/model/memory";
import { hydrateTitles } from "@/entities/artifact/model/artifacts";
import { migrateToSecureStorage } from "@/shared/lib/migrateSecrets";
import { clearDraft } from "@/pages/chat/model/drafts";
import { ChatScreen } from "@/pages/chat/ui/ChatScreen";
import { CodeScreen } from "@/pages/code/ui/CodeScreen";
import { ProvidersScreen } from "@/pages/providers/ui/ProvidersScreen";
import { MemoryScreen } from "@/pages/memory/ui/MemoryScreen";
import { SettingsScreen } from "@/pages/settings/ui/SettingsScreen";
import { SearchModal } from "@/widgets/search-modal/ui/SearchModal";
import { ShortcutsModal } from "@/widgets/shortcuts-modal/ui/ShortcutsModal";
import { Sidebar } from "@/app/ui/Sidebar";
import { Icon } from "@/shared/ui/Icon";
import type { ScreenId } from "@/app/ui/ChatGroup";

// Fixed theme (baked-in defaults).
const ROOT_STYLE = {
  "--accent": "#3B82F6",
  "--font-ui": "'Geist', system-ui, sans-serif",
  "--font-mono": "'Geist Mono', monospace",
  "--su": 1,
  "--grain-op": (25 / 100) * 0.55,
} as CSSProperties;

// Resizable sidebar (grid first column). Width is layout px; the shell's `zoom` (see .app)
// scales the rendered size, so drag deltas (screen px) are divided back out.
const NAV_KEY = "modelius.navWidth";
const NAV_MIN = 200;
const NAV_MAX = 460;
const clampNav = (w: number) => Math.max(NAV_MIN, Math.min(w, NAV_MAX));

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("chat");
  const { policy, zoom, theme } = useSettings(); // routing policy + UI zoom + theme (persisted)

  // Drive the light/dark palette via a data-theme attribute on <html> so body + app both pick it up.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navWidth, setNavWidth] = useState(() => {
    const saved = Number(localStorage.getItem(NAV_KEY));
    return saved >= NAV_MIN ? clampNav(saved) : 252;
  });
  const [navResizing, setNavResizing] = useState(false); // disables the grid transition mid-drag

  // Drag the sidebar/stage boundary to resize. clientX is screen px → divide by zoom for layout px.
  const startNavResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = navWidth;
    setNavResizing(true); // follow the cursor 1:1, no .28s grid easing
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => setNavWidth(clampNav(startW + (ev.clientX - startX) / zoom));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setNavResizing(false);
      setNavWidth((w) => {
        localStorage.setItem(NAV_KEY, String(w));
        return w;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

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
    if (id !== activeChatId) return;
    // Deleting the chat we're viewing: land on a fresh new-chat slot. If the deleted chat *was*
    // the slot, mint a new id so ChatScreen actually remounts clean (same id wouldn't).
    if (id === newChatId) {
      const fresh = crypto.randomUUID();
      setNewChatId(fresh);
      setActiveChatId(fresh);
    } else {
      gotoNewChat();
    }
  };

  // Code mode has its own chats — mirror the activeChatId / new-slot pattern above.
  const [activeCodeChatId, setActiveCodeChatId] = useState<string>(() => crypto.randomUUID());
  const [newCodeChatId, setNewCodeChatId] = useState(activeCodeChatId);
  const gotoNewCode = (): string => {
    let id = newCodeChatId;
    if (!isEmptyCodeSession(id)) {
      id = crypto.randomUUID();
      setNewCodeChatId(id);
    }
    setActiveCodeChatId(id);
    return id;
  };
  const newCode = () => {
    gotoNewCode();
    setScreen("code");
  };
  const openCode = (id: string) => {
    setActiveCodeChatId(id);
    setScreen("code");
  };
  const removeCode = (id: string) => {
    deleteCodeChat(id);
    dropCodeSession(id);
    if (id !== activeCodeChatId) return;
    if (id === newCodeChatId) {
      const fresh = crypto.randomUUID();
      setNewCodeChatId(fresh);
      setActiveCodeChatId(fresh);
    } else {
      gotoNewCode();
    }
  };

  // "New" and Cmd+N are mode-aware: create a code session in Code mode, else a chat.
  const newInMode = () => (screen === "code" ? newCode() : newChat());
  // Latest newInMode for the global keydown handler (which subscribes once).
  const newChatRef = useRef(newInMode);
  newChatRef.current = newInMode;

  // Startup: migrate secrets into the keychain, decrypt the in-RAM stores, then warm live
  // model lists so connected providers join the routing pool before the picker opens.
  useEffect(() => {
    void (async () => {
      await migrateToSecureStorage();
      await Promise.all([hydrateSettings(), hydrateMemory(), hydrateChatIndex(), hydrateCodeIndex(), hydrateTitles()]);
      void loadDynamicPricing(); // live per-token prices (OpenRouter) → routing cost + real $ per turn
      void listOllamaModels().catch(() => {});
      for (const pid of KEY_PROVIDER_IDS) if (hasKey(pid)) void listKeyProviderModels(pid).catch(() => {});
    })();
  }, []);

  // Global shortcuts. Mod (Cmd/Ctrl): K search, N new chat, / shortcuts. Bare "?" also opens
  // shortcuts, but only when not typing into a field.
  useEffect(() => {
    const typingInField = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (mod && k === "n") {
        e.preventDefault();
        newChatRef.current();
      } else if ((mod && k === "/") || (e.key === "?" && !typingInField())) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.6 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

  return (
    <div className={"app" + (navCollapsed ? " nav-collapsed" : "") + (navResizing ? " nav-resizing" : "")} style={{ ...ROOT_STYLE, "--nav-w": navWidth + "px", "--app-zoom": zoom } as CSSProperties}>
      <div className="grain" style={{ backgroundImage: noise, opacity: "var(--grain-op)" }} />
      <Sidebar
        screen={screen}
        setScreen={setScreen}
        onNewChat={newInMode}
        onOpenSearch={() => setSearchOpen(true)}
        onCollapse={() => setNavCollapsed(true)}
        activeChatId={activeChatId}
        onOpenChat={openChat}
        onDeleteChat={removeChat}
        onPinChat={pinChat}
        onRenameChat={renameChat}
        activeCodeChatId={activeCodeChatId}
        onOpenCode={openCode}
        onDeleteCode={removeCode}
        onPinCode={pinCodeChat}
        onRenameCode={renameCodeChat}
      />
      {!navCollapsed && (
        <div className="nav-resize" style={{ left: navWidth }} onMouseDown={startNavResize} title="Drag to resize" />
      )}
      {navCollapsed && (
        <button className="sb-reopen" title="Show sidebar" onClick={() => setNavCollapsed(false)}>
          <Icon name="panelLeftOpen" size={16} />
        </button>
      )}
      <main className="stage">
        {/* Streaming lives in the session store, so a screen switch unmount doesn't abort it.
            Keyed by `screen` so a screen change plays the enter animation, but switching between
            chats (same key "chat") does not — only the inner ChatScreen remounts by activeChatId. */}
        <div className="stage-swap" key={screen}>
          {screen === "chat" && (
            <ChatScreen
              key={activeChatId}
              chatId={activeChatId}
              showDemo={activeChatId === startupChatId.current}
              policy={policy}
              onConnectModel={() => setScreen("providers")}
            />
          )}
          {screen === "code" && <CodeScreen key={activeCodeChatId} chatId={activeCodeChatId} />}
          {screen === "providers" && <ProvidersScreen />}
          {screen === "memory" && <MemoryScreen />}
          {screen === "settings" && <SettingsScreen />}
        </div>
      </main>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onOpenChat={openChat} />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
