// App.tsx — shell: sidebar nav, conversation history, screen routing.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "highlight.js/styles/github-dark.css";
import "@/app/styles/styles.css";
import { hydrateSettings, useSettings } from "@/entities/settings/model/settings";
import { deleteChat, pinChat, renameChat, hydrateChatIndex } from "@/entities/chat/model/chats";
import { deleteCodeChat, pinCodeChat, renameCodeChat, hydrateCodeIndex } from "@/entities/agent/model/codeChats";
import { dropSession, isEmptySession, flushAll } from "@/pages/chat/model/sessionStore";
import { isTauri } from "@/shared/api/tauri";
import { dropCodeChat, isEmptyCodeChat } from "@/features/run-agent/lib/codeChatRegistry";
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
import { WindowControls } from "@/app/ui/WindowControls";
import { Icon } from "@/shared/ui/Icon";
import { dragResize, persistWidth, restoreWidth } from "@/shared/lib/dragResize";
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

// One "active + pending-new slot" pair per workspace mode (chat and code mirror each other).
// The pending slot id is stable across visits to existing chats so its unsent draft survives;
// a fresh id is minted only once the slot actually has messages.
function useChatSlots(isEmpty: (id: string) => boolean, onDelete: (id: string) => void) {
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const [newId, setNewId] = useState(activeId);

  const gotoNew = (): string => {
    let id = newId;
    if (!isEmpty(id)) {
      id = crypto.randomUUID();
      setNewId(id);
    }
    setActiveId(id);
    return id;
  };

  const remove = (id: string) => {
    onDelete(id);
    if (id !== activeId) return;
    // Deleting the chat we're viewing: land on a fresh new-chat slot. If the deleted chat *was*
    // the slot, mint a new id so the screen actually remounts clean (same id wouldn't).
    if (id === newId) {
      const fresh = crypto.randomUUID();
      setNewId(fresh);
      setActiveId(fresh);
    } else {
      gotoNew();
    }
  };

  return { activeId, setActiveId, gotoNew, remove };
}

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("chat");
  // Workspace mode (Chat vs Code) — sticky. Providers/Memory/Settings are overlay screens that
  // don't belong to a mode, so they must not reset it back to Chat while you browse them.
  const [mode, setMode] = useState<"chat" | "code">("chat");
  useEffect(() => {
    if (screen === "chat" || screen === "code") setMode(screen);
  }, [screen]);
  const { policy, zoom, theme } = useSettings(); // routing policy + UI zoom + theme (persisted)

  // Drive the light/dark palette via a data-theme attribute on <html> so body + app both pick it up.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navWidth, setNavWidth] = useState(() => restoreWidth(NAV_KEY, NAV_MIN, 252, clampNav));
  const [navResizing, setNavResizing] = useState(false); // disables the grid transition mid-drag

  // Drag the sidebar/stage boundary to resize.
  const startNavResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setNavResizing(true); // follow the cursor 1:1, no .28s grid easing
    dragResize({
      startX: e.clientX,
      startW: navWidth,
      zoom,
      dir: 1,
      clamp: clampNav,
      onWidth: setNavWidth,
      onDone: () => {
        setNavResizing(false);
        setNavWidth((w) => {
          persistWidth(NAV_KEY, w);
          return w;
        });
      },
    });
  };

  // activeId keys ChatScreen / CodeScreen, so switching/opening remounts with that chat's state.
  const chatSlots = useChatSlots(isEmptySession, (id) => {
    deleteChat(id);
    dropSession(id); // drop live session so a stray commit can't resurrect the chat
    clearDraft(id);
  });
  const codeSlots = useChatSlots(isEmptyCodeChat, (id) => {
    deleteCodeChat(id);
    dropCodeChat(id);
  });
  const startupChatId = useRef(chatSlots.activeId); // demo thread only seeds this chat

  const newChat = () => {
    chatSlots.gotoNew();
    setScreen("chat");
  };
  const openChat = (id: string) => {
    chatSlots.setActiveId(id);
    setScreen("chat");
    setSearchOpen(false);
  };
  const newCode = () => {
    codeSlots.gotoNew();
    setScreen("code");
  };
  const openCode = (id: string) => {
    codeSlots.setActiveId(id);
    setScreen("code");
  };

  // "New" and Cmd+N are mode-aware: create a code session in Code mode, else a chat.
  const newInMode = () => (mode === "code" ? newCode() : newChat());
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

  // Flush the chat store's debounced persist before the app closes/hides, so a turn that finished
  // within the 400ms debounce window isn't lost. Tauri: intercept the close so the flush completes
  // before the process exits; web: best-effort on hide/unload.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") void flushAll(); };
    const onUnload = () => { void flushAll(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        unlisten = await w.onCloseRequested((event) => {
          event.preventDefault(); // synchronously hold the close, then flush and destroy
          void (async () => {
            await flushAll();
            await w.destroy();
          })();
        });
      })();
    }
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      unlisten?.();
    };
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
    <div className={"app" + (isTauri() ? " tauri" : "") + (navCollapsed ? " nav-collapsed" : "") + (navResizing ? " nav-resizing" : "")} style={{ ...ROOT_STYLE, "--nav-w": navWidth + "px", "--app-zoom": zoom, "--cap-h": screen === "code" ? "44px" : "52px" } as CSSProperties}>
      <div className="grain" style={{ backgroundImage: noise, opacity: "var(--grain-op)" }} />
      {isTauri() && <WindowControls />}
      <Sidebar
        screen={screen}
        mode={mode}
        setScreen={setScreen}
        onNewChat={newInMode}
        onOpenSearch={() => setSearchOpen(true)}
        onCollapse={() => setNavCollapsed(true)}
        chat={{ activeId: chatSlots.activeId, open: openChat, remove: chatSlots.remove, pin: pinChat, rename: renameChat }}
        code={{ activeId: codeSlots.activeId, open: openCode, remove: codeSlots.remove, pin: pinCodeChat, rename: renameCodeChat }}
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
              key={chatSlots.activeId}
              chatId={chatSlots.activeId}
              showDemo={chatSlots.activeId === startupChatId.current}
              policy={policy}
              onConnectModel={() => setScreen("providers")}
            />
          )}
          {screen === "code" && <CodeScreen key={codeSlots.activeId} chatId={codeSlots.activeId} />}
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
