// ChatScreen.tsx — chat page view: thread, composer host, artifact-panel host, top bar.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatThread } from "@/widgets/chat-thread/ui/ChatThread";
import { ArtifactPanel } from "@/widgets/artifact-panel/ui/ArtifactPanel";
import { Icon } from "@/shared/ui/Icon";
import { codeSegs } from "@/shared/lib/markdown";
import { type Message, type PolicyId } from "@/entities/model/model/registry";
import { providerKeyForBackend } from "@/entities/model/model/backend";
import { useChatProvider } from "@/entities/session/model/usageLimits";
import { UsageMeter } from "@/widgets/usage-meter/ui/UsageMeter";
import { ctxForBackend } from "@/entities/model/model/apiIds";
import { estimateTokens, ctxTokens } from "@/shared/lib/tokens";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { makeArtifact, type Artifact } from "@/entities/artifact/model/artifacts";
import { collectVersions } from "@/entities/artifact/lib/versions";
import { ExportButton } from "@/features/export-chat/ui/ExportButton";
import { getChats } from "@/entities/chat/model/chats";
import { useSession, regenerate, editAndResend, continueMessage, switchBranch, setChatPrompt } from "@/pages/chat/model/sessionStore";
import { useComposerModelState } from "@/pages/chat/model/useComposerModelState";
import { Composer } from "@/pages/chat/ui/Composer";

// What the right panel shows: a static artifact (composer chip preview) or a live
// locator into a thread message's Nth code block.
type OpenRef = { kind: "static"; art: Artifact } | { kind: "msg"; msgIndex: number; blockIndex: number };

// Live-resolve the Nth code block of a (possibly streaming) message, so the panel
// re-derives content on every token without a re-click.
function resolveBlock(msg: Message | undefined, blockIndex: number): Artifact | null {
  if (!msg) return null;
  const body = msg.streaming ? msg.shown || "" : msg.text;
  const c = codeSegs(body)[blockIndex];
  return c ? makeArtifact(c.lang, c.code) : null;
}

// Greeting for the new-chat hero.
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Per-chat persona: a system prompt scoped to this chat, overriding the global custom
// instructions. The button highlights when one is set; the popover autosaves on outside-click.
function PersonaButton({ value, onSave }: { value: string; onSave: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-sync from the stored value on chat switch (while closed).
  useEffect(() => {
    if (!open) setDraft(value);
  }, [value, open]);

  // Outside-click autosaves and closes.
  useOutsideClick(wrapRef, open, () => {
    onSave(draft.trim());
    setOpen(false);
  });

  return (
    <div className="persona-wrap" ref={wrapRef}>
      <button
        className={"persona-btn" + (value ? " on" : "")}
        title={value ? "Chat persona — custom prompt set" : "Set a persona for this chat"}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sliders" size={15} />
      </button>
      {open && (
        <div className="persona-pop">
          <div className="persona-pop-head">Chat persona</div>
          <p className="persona-pop-sub">
            A system prompt just for this chat — overrides your global custom instructions. Empty inherits it.
          </p>
          <textarea
            className="persona-pop-ta"
            autoFocus
            value={draft}
            placeholder="e.g. You are a senior Rust reviewer. Be terse and blunt."
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="persona-pop-bar">
            <button
              className="ue-btn"
              onClick={() => {
                setDraft(value);
                setOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              className="ue-btn primary"
              onClick={() => {
                onSave(draft.trim());
                setOpen(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatScreen({
  policy,
  chatId,
  showDemo = false,
  onConnectModel,
}: {
  policy: PolicyId;
  chatId: string;
  showDemo?: boolean;
  onConnectModel?: () => void;
}) {
  // Demo thread only on the startup chat of a first-ever launch (no saved chats yet).
  const demo = showDemo && getChats().length === 0;
  // State + streaming live in the global session store, surviving a chat/screen switch.
  const { messages, phase, compacting, title, titleSettled, loading, customPrompt, summary, siblings } = useSession(chatId, demo);
  // Model pick + thinking/web/effort live in one hook shared with the composer — the screen
  // reads them for the routing callbacks, the ctx meter, and the usage meter.
  const model = useComposerModelState(chatId, messages, loading);
  const { modelSel, thinking, web, effort } = model;
  const [openRef, setOpenRef] = useState<OpenRef | null>(null); // artifact the right panel shows

  const busy = phase !== "idle";

  // Empty chat → centered greeting + composer. While a saved body is still loading,
  // hold off the hero so switching chats doesn't flash the new-chat page.
  const isNewChat = messages.length === 0 && phase === "idle" && !loading;

  // Input block: centered (new chat) or pinned to the bottom.
  const composer = (
    <Composer
      chatId={chatId}
      policy={policy}
      busy={busy}
      model={model}
      onConnectModel={onConnectModel}
      onPreview={(art) => setOpenRef({ kind: "static", art })}
    />
  );

  // Stable thread callbacks: the rows are memoized, so a fresh closure per render would defeat
  // the row memo on every streamed token.
  const onOpenBlock = useCallback((mi: number, bi: number) => setOpenRef({ kind: "msg", msgIndex: mi, blockIndex: bi }), []);
  const onRegenerate = useCallback(
    () => regenerate(chatId, { policy, modelSel, thinking, effort, web }),
    [chatId, policy, modelSel, thinking, effort, web]
  );
  const onEditResend = useCallback(
    (mi: number, text: string) => editAndResend(chatId, mi, text, { policy, modelSel, thinking, effort, web }),
    [chatId, policy, modelSel, thinking, effort, web]
  );
  const onContinue = useCallback(
    () => continueMessage(chatId, { policy, modelSel, thinking, effort, web }),
    [chatId, policy, modelSel, thinking, effort, web]
  );
  const onSwitchBranch = useCallback((p: number, dir: -1 | 1) => switchBranch(chatId, p, dir), [chatId]);

  const firstUser = messages.find((m) => m.role === "user");
  // Neutral placeholder until the title generates; fall back to first message only once settled.
  const headerTitle = title || (titleSettled && firstUser ? firstUser.text : "New chat");

  // Context-fill indicator: mirror realSend's window budgeting so the bar's colour flips exactly
  // when compaction kicks in. Window = active model's ctx (manual pick) or the last routed pick.
  const ctxMeter = useMemo(() => {
    let ctxStr = "200K";
    if (modelSel) ctxStr = ctxForBackend(modelSel.backend);
    else
      for (let i = messages.length - 1; i >= 0; i--)
        if (messages[i].decision) { ctxStr = messages[i].decision!.chosen.ctx; break; }
    const win = ctxTokens(ctxStr);
    const used = messages.reduce((n, m) => n + estimateTokens(m.text), estimateTokens(summary));
    return { used, win, pct: win > 0 ? used / win : 0 };
  }, [messages, summary, modelSel]);

  // Account the usage meter reads: the manual pick's backend, else the last backend that answered.
  const lastProviderKey = useChatProvider(chatId);
  const activeProviderKey = modelSel ? providerKeyForBackend(modelSel.backend) : lastProviderKey;

  // Resolve the open artifact live from current state, plus whether that block is still generating.
  const openMsg = openRef?.kind === "msg" ? messages[openRef.msgIndex] : undefined;
  const openArt = !openRef ? null : openRef.kind === "static" ? openRef.art : resolveBlock(openMsg, openRef.blockIndex);
  const openGenerating =
    openRef?.kind === "msg" && !!openMsg?.streaming && openMsg.text === "" && codeSegs(openMsg.shown || "")[openRef.blockIndex]?.open;

  // Version chain for the open artifact (by title, within this chat). Only for thread artifacts —
  // and only computed while the panel is open: collectVersions re-segments and re-hashes every
  // message, which would otherwise run on each streamed token.
  const versionMap = useMemo(
    () => (openRef?.kind === "msg" ? collectVersions(messages) : null),
    [messages, openRef]
  );
  const openVersions =
    openRef?.kind === "msg" && openArt ? versionMap?.get(openArt.title) ?? [] : [];
  const openVersionArts = openVersions.map((v) => v.art);
  const openVersionIndex =
    openRef?.kind === "msg"
      ? openVersions.findIndex((v) => v.msgIndex === openRef.msgIndex && v.blockIndex === openRef.blockIndex)
      : -1;

  return (
    <div className="chat-wrap">
      <div className="chat-main">
        {/* Top bar */}
        <header className="chat-top" data-tauri-drag-region>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 540,
                letterSpacing: "-0.01em",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {headerTitle}
            </span>
            <span className="chat-top-meta">{messages.length} messages</span>
            {messages.length > 0 && (
              <UsageMeter used={ctxMeter.used} win={ctxMeter.win} providerKey={activeProviderKey} model={modelSel?.backend.model} />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ExportButton title={headerTitle} messages={messages} createdAt={getChats().find((c) => c.id === chatId)?.createdAt} />
            <PersonaButton value={customPrompt} onSave={(t) => setChatPrompt(chatId, t)} />
          </div>
        </header>

        {isNewChat ? (
          <div className="chat-hero">
            <div className="hero-inner">
              <div className="hero-greeting">
                <Icon name="spark" size={26} style={{ color: "var(--accent)" }} />
                <h1>{greeting()}</h1>
              </div>
              <div className="hero-composer">{composer}</div>
            </div>
          </div>
        ) : (
          <>
            <ChatThread
              messages={messages}
              phase={phase}
              compacting={compacting}
              policy={policy}
              manual={!!modelSel}
              onOpenBlock={onOpenBlock}
              onRegenerate={onRegenerate}
              onEditResend={onEditResend}
              onContinue={onContinue}
              siblings={siblings}
              onSwitchBranch={onSwitchBranch}
            />
            <div className="composer-wrap">{composer}</div>
          </>
        )}
      </div>

      {openArt ? (
        <ArtifactPanel
          artifact={openArt}
          onClose={() => setOpenRef(null)}
          generating={openGenerating}
          versions={openVersionArts}
          versionIndex={openVersionIndex}
        />
      ) : null}
    </div>
  );
}
