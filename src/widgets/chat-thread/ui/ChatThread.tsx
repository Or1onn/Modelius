// ChatThread.tsx — scrolling message list: user/assistant turns, reasoning + memory notes, routing rows.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/shared/ui/Icon";
import { branchGroup } from "@/pages/chat/lib/branches";
import { ModelBadge } from "@/entities/model/ui/ModelBadge";
import { Markdown, segmentBody } from "@/shared/lib/markdown";
import { fmtCompact } from "@/shared/lib/tokens";
import { POLICIES, type PolicyId, type Message } from "@/entities/model/model/registry";
import { isLargeBlock, isFileArtifact, makeArtifact, wrapFence, type Artifact } from "@/entities/artifact/model/artifacts";

// Short wall-clock time for a message; full date in the tooltip.
const fmtTime = (ts?: number) => (ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const fmtFull = (ts?: number) => (ts ? new Date(ts).toLocaleString() : "");

// A code block as a clickable card; click opens it in the ArtifactPanel. `generating` = still streaming.
function ArtifactCard({ art, onOpen, generating }: { art: Artifact; onOpen: () => void; generating?: boolean }) {
  return (
    <button className={"artifact-card" + (generating ? " generating" : "")} onClick={onOpen} title="Open artifact">
      <span className="ac-icon">
        <Icon name="code" size={16} />
      </span>
      <span className="ac-text">
        <span className="ac-title">{art.title}</span>
        {generating && (
          <span className="ac-sub">
            <span className="ac-pulse" />
            Generating…
          </span>
        )}
      </span>
      <span className="ac-open">
        <Icon name="arrowR" size={14} />
      </span>
    </button>
  );
}

// A user message: large pasted code blocks become cards, prose stays in bubbles.
// No big blocks → a single bubble (the common case).
function UserContent({
  text,
  images,
  onOpen,
}: {
  text: string;
  images?: Message["images"];
  onOpen: (blockIndex: number) => void;
}) {
  const imgRow = images?.length ? (
    <div className="user-images">
      {images.map((im, k) => (
        <img className="user-image" key={k} src={im.dataUrl} alt={im.name} title={im.name} />
      ))}
    </div>
  ) : null;
  const segs = segmentBody(text);
  // Card if large OR an attached file (a file stays an artifact at any size).
  const asArtifact = (code: string) => isLargeBlock(code) || isFileArtifact(code);
  if (!segs.some((s) => s.kind === "code" && asArtifact(s.code)))
    return (
      <div className="user-stack">
        {imgRow}
        {text && <div className="bubble-user">{text}</div>}
      </div>
    );
  // Cards float ABOVE prose; codeIdx stays in document order so the panel resolves the right block.
  const cards: ReactNode[] = [];
  const rest: ReactNode[] = [];
  let codeIdx = -1;
  segs.forEach((s, k) => {
    if (s.kind === "text") {
      const t = s.text.trim();
      if (t) rest.push(<div className="bubble-user" key={k}>{t}</div>);
      return;
    }
    codeIdx++;
    if (asArtifact(s.code)) {
      const idx = codeIdx;
      const art = makeArtifact(s.lang, s.code);
      cards.push(<ArtifactCard art={art} onOpen={() => onOpen(idx)} key={k} />);
    } else {
      rest.push(<div className="bubble-user" key={k}>{wrapFence(s.lang, s.code)}</div>);
    }
  });
  return (
    <div className="user-stack">
      {imgRow}
      {cards}
      {rest}
    </div>
  );
}

// A user turn with an inline edit affordance. Editing truncates the thread from here and resends.
function UserRow({
  msg,
  index,
  canEdit,
  onOpenBlock,
  onEditResend,
}: {
  msg: Message;
  index: number;
  canEdit: boolean;
  onOpenBlock: (msgIndex: number, blockIndex: number) => void;
  onEditResend?: (msgIndex: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.text);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 320) + "px";
  };
  // On entering edit mode: focus, size to content, caret at end.
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    autosize();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  const save = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== msg.text) onEditResend?.(index, t);
  };

  if (editing)
    return (
      <div className="row-user">
        <div className="user-edit">
          <textarea
            ref={taRef}
            className="user-edit-ta"
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              autosize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="user-edit-bar">
            <button className="ue-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="ue-btn primary" onClick={save}>
              Send
            </button>
          </div>
        </div>
      </div>
    );

  return (
    <div className="row-user">
      <div className="user-col">
        <UserContent text={msg.text} images={msg.images} onOpen={(bi) => onOpenBlock(index, bi)} />
        <div className="user-foot">
          {canEdit && (
            <button
              className="asst-act"
              title="Edit & resend"
              onClick={() => {
                setDraft(msg.text);
                setEditing(true);
              }}
            >
              <Icon name="edit" size={15} />
            </button>
          )}
          {msg.ts && <span className="msg-ts" title={fmtFull(msg.ts)}>{fmtTime(msg.ts)}</span>}
        </div>
      </div>
    </div>
  );
}

// An assistant answer: prose as markdown; a code block as a card when large (≥15 lines / 4 KB),
// else inline. Same size test while streaming, so a small block stays inline from its first token.
function AssistantBody({ text, streaming, onOpen }: { text: string; streaming: boolean; onOpen: (blockIndex: number) => void }) {
  const segs = segmentBody(text);
  let codeIdx = -1;
  return (
    <>
      {segs.map((s, k) => {
        if (s.kind === "text") {
          // Drop a lone streaming fence opener ("```ts" with no newline yet).
          if (streaming && k === segs.length - 1 && /^```[^\n]*$/.test(s.text.trim())) return null;
          return <Markdown key={k} text={s.text} />;
        }
        codeIdx++;
        const idx = codeIdx;
        const asCard = isLargeBlock(s.code);
        if (asCard) {
          const art = makeArtifact(s.lang, s.code);
          return <ArtifactCard key={k} art={art} onOpen={() => onOpen(idx)} generating={s.open && streaming} />;
        }
        return <Markdown key={k} text={wrapFence(s.lang, s.code)} />;
      })}
    </>
  );
}

// Collapsible reasoning trace above an answer; open by default while streaming.
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="reasoning">
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="spark" size={12} style={{ color: "var(--accent)" }} />
        <span style={{ flex: 1, textAlign: "left" }}>{streaming ? "Thinking…" : "Thinking"}</span>
        <Icon name="chevronD" size={13} style={{ transform: open ? "none" : "rotate(-90deg)", opacity: 0.6 }} />
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

// "Memory updated" note: durable facts saved this turn. Click to expand.
function MemoryNote({ facts }: { facts: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mem-note">
      <button className="mem-note-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="memory" size={12} style={{ color: "var(--accent)" }} />
        <span>Memory updated</span>
        <span className="mem-note-count">{facts.length}</span>
        <Icon name="chevronD" size={12} style={{ transform: open ? "none" : "rotate(-90deg)", opacity: 0.6 }} />
      </button>
      {open && (
        <ul className="mem-note-list">
          {facts.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Per-answer actions: copy (with brief "copied" feedback) and regenerate (last turn only).
function AsstActions({ text, canRegenerate, onRegenerate }: { text: string; canRegenerate: boolean; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {}
    );
  return (
    <>
      <button className="asst-act" title={copied ? "Copied" : "Copy"} onClick={copy}>
        <Icon name={copied ? "check" : "copy"} size={15} />
      </button>
      {canRegenerate && (
        <button className="asst-act" title="Regenerate" onClick={onRegenerate}>
          <Icon name="refresh" size={15} />
        </button>
      )}
    </>
  );
}

// ◀ k/n ▶ switcher shown at a branch divergence point. `align` matches the diverging turn's side.
function BranchNav({ n, k, align, onPrev, onNext }: { n: number; k: number; align: "user" | "asst"; onPrev: () => void; onNext: () => void }) {
  return (
    <div className={"branch-nav " + align}>
      <button className="branch-arrow" onClick={onPrev} title="Previous version">
        <Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} />
      </button>
      <span className="branch-count">
        {k + 1}/{n}
      </span>
      <button className="branch-arrow" onClick={onNext} title="Next version">
        <Icon name="chevron" size={13} />
      </button>
    </div>
  );
}

export function ChatThread({
  messages,
  phase,
  compacting,
  policy,
  manual = false,
  onOpenBlock,
  onRegenerate,
  onEditResend,
  onContinue,
  siblings = [],
  onSwitchBranch,
}: {
  messages: Message[];
  phase: "idle" | "routing" | "streaming";
  compacting: boolean;
  policy: PolicyId;
  manual?: boolean; // a specific model is picked → "Thinking…" instead of the routing line
  onOpenBlock: (msgIndex: number, blockIndex: number) => void;
  onRegenerate?: () => void; // re-run the last assistant turn
  onEditResend?: (msgIndex: number, text: string) => void; // edit a user turn and resend
  onContinue?: () => void; // continue a turn cut off by max output tokens
  siblings?: Message[][]; // inactive branch threads (for the ◀ k/n ▶ navigator)
  onSwitchBranch?: (p: number, dir: -1 | 1) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // at bottom → follow the stream; scrolling up unpins
  const [atBottom, setAtBottom] = useState(true); // mirrors pinnedRef for the floating button

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  const toBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setAtBottom(true);
  };

  // Active + sibling threads, for the per-position branch navigator.
  const allThreads = useMemo(() => [...siblings, messages], [siblings, messages]);

  return (
    <>
    <div
      className="thread"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        pinnedRef.current = pinned;
        setAtBottom(pinned);
      }}
    >
      <div className="thread-inner">
        {messages.map((msg, i) => {
          const grp = onSwitchBranch && siblings.length ? branchGroup(allThreads, messages, i) : null;
          const nav = grp ? (
            <BranchNav
              n={grp.versions.length}
              k={grp.k}
              align={msg.role === "user" ? "user" : "asst"}
              onPrev={() => onSwitchBranch!(i, -1)}
              onNext={() => onSwitchBranch!(i, 1)}
            />
          ) : null;
          const row =
            msg.role === "user" ? (
              <UserRow
                msg={msg}
                index={i}
              canEdit={phase === "idle"}
              onOpenBlock={onOpenBlock}
              onEditResend={onEditResend}
            />
          ) : (
            <div className={"row-asst" + (!msg.streaming && msg.text.startsWith("⚠️ ") ? " asst-error" : "")}>
              <div className="asst-head">
                {msg.modelLabel ? (
                  <ModelBadge label={msg.modelLabel} provider={msg.modelProvider} size="sm" />
                ) : (
                  <ModelBadge modelId={msg.decision!.chosen.id} model={msg.decision!.chosen} size="sm" />
                )}
                <span className="asst-meta">
                  <Icon name="bolt" size={11} style={{ opacity: 0.6 }} />
                  {msg.latencyMs != null ? (msg.latencyMs / 1000).toFixed(1) : msg.decision!.latency}s
                </span>
                {msg.usage && (
                  <span className="asst-meta mono" title="tokens sent / received / reasoning">
                    ↑ {fmtCompact(msg.usage.inputTokens)} ↓ {fmtCompact(msg.usage.outputTokens)}
                    {!!msg.usage.reasoningTokens && <> ⟳ {fmtCompact(msg.usage.reasoningTokens)}</>}
                  </span>
                )}
                {/* $ only for metered turns; subscription/offline (usage, no cost) shows nothing.
                    No estimate while streaming (would vanish at completion on a subscription).
                    The estimate branch is only for static seed turns. */}
                {msg.cost != null ? (
                  <span className="asst-meta mono">${msg.cost > 0 && msg.cost < 0.001 ? msg.cost.toFixed(6) : msg.cost.toFixed(4)}</span>
                ) : !msg.usage && !msg.streaming ? (
                  <span className="asst-meta mono">
                    {msg.decision!.chosenCost === 0 ? "free" : "$" + msg.decision!.chosenCost.toFixed(4)}
                  </span>
                ) : null}
                {msg.ts && !msg.streaming && (
                  <span className="asst-meta msg-ts" title={fmtFull(msg.ts)}>
                    {fmtTime(msg.ts)}
                  </span>
                )}
              </div>
              {msg.reasoning && <ReasoningBlock text={msg.reasoning} streaming={!!msg.streaming} />}
              <div className="asst-body md">
                <AssistantBody
                  text={msg.streaming ? msg.shown || "" : msg.text}
                  streaming={!!msg.streaming && msg.text === ""}
                  onOpen={(bi) => onOpenBlock(i, bi)}
                />
                {msg.genImages && msg.genImages.length > 0 && (
                  <div className="asst-images">
                    {msg.genImages.map((u, k) => (
                      <img className="asst-image" key={k} src={u} alt="Generated image" />
                    ))}
                  </div>
                )}
                {msg.streaming && <span className="cursor" />}
              </div>
              {msg.memory && msg.memory.length > 0 && <MemoryNote facts={msg.memory} />}
              {!msg.streaming &&
                (msg.text.startsWith("⚠️ ") && phase === "idle" && i === messages.length - 1 ? (
                  <div className="asst-foot">
                    <button className="retry-btn" onClick={onRegenerate}>
                      <Icon name="refresh" size={14} />
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="asst-foot">
                    <AsstActions
                      text={msg.text}
                      canRegenerate={phase === "idle" && i === messages.length - 1}
                      onRegenerate={onRegenerate}
                    />
                    {msg.truncated && phase === "idle" && i === messages.length - 1 && (
                      <button className="continue-btn" onClick={onContinue} title="Response cut off by the token limit">
                        <Icon name="arrowR" size={14} />
                        Continue
                      </button>
                    )}
                  </div>
                ))}
            </div>
          );
          return (
            <Fragment key={i}>
              {row}
              {nav}
            </Fragment>
          );
        })}

        {phase === "routing" && (
          <div className="row-asst">
            <div className="routing-inline">
              <span className="ri-pulse" />
              {manual ? "Thinking…" : `Routing under ${POLICIES[policy].label} policy…`}
            </div>
          </div>
        )}

        {compacting && (
          <div className="row-asst">
            <div className="routing-inline">
              <span className="ri-pulse" />
              Compressing earlier context…
            </div>
          </div>
        )}
      </div>
    </div>
    {!atBottom && (
      <button className="scroll-bottom-btn" onClick={toBottom} title="Scroll to bottom">
        <Icon name="chevronD" size={18} />
      </button>
    )}
    </>
  );
}
