// ChatThread.tsx — scrolling message list: user/assistant turns, reasoning + memory notes, routing rows.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/shared/ui/Icon";
import { ModelBadge } from "@/entities/model/ui/ModelBadge";
import { Markdown, segmentBody } from "@/shared/lib/markdown";
import { fmtCompact } from "@/shared/lib/tokens";
import { POLICIES, type PolicyId, type Message } from "@/entities/model/model/registry";
import { isLargeBlock, isFileArtifact, makeArtifact, wrapFence, type Artifact } from "@/entities/artifact/model/artifacts";

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

export function ChatThread({
  messages,
  phase,
  compacting,
  policy,
  manual = false,
  onOpenBlock,
}: {
  messages: Message[];
  phase: "idle" | "routing" | "streaming";
  compacting: boolean;
  policy: PolicyId;
  manual?: boolean; // a specific model is picked → "Thinking…" instead of the routing line
  onOpenBlock: (msgIndex: number, blockIndex: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // at bottom → follow the stream; scrolling up unpins

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, phase]);

  return (
    <div
      className="thread"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="thread-inner">
        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div key={i} className="row-user">
              <UserContent text={msg.text} images={msg.images} onOpen={(bi) => onOpenBlock(i, bi)} />
            </div>
          ) : (
            <div key={i} className="row-asst">
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
                  <span className="asst-meta mono" title="tokens sent / received">
                    ↑ {fmtCompact(msg.usage.inputTokens)} ↓ {fmtCompact(msg.usage.outputTokens)}
                  </span>
                )}
                {/* $ only for metered turns; subscription/offline (usage, no cost) shows nothing.
                    No estimate while streaming (would vanish at completion on a subscription).
                    The estimate branch is only for static seed turns. */}
                {msg.cost != null ? (
                  <span className="asst-meta mono">
                    ${msg.cost.toFixed(4)}
                    {msg.priceSource && (
                      <span
                        className={"price-src " + msg.priceSource}
                        title={msg.priceSource === "live" ? "Live price — OpenRouter catalog" : "Estimated from the built-in price table"}
                      >
                        {msg.priceSource === "live" ? "live" : "≈ table"}
                      </span>
                    )}
                  </span>
                ) : !msg.usage && !msg.streaming ? (
                  <span className="asst-meta mono">
                    {msg.decision!.chosenCost === 0 ? "free" : "$" + msg.decision!.chosenCost.toFixed(4)}
                  </span>
                ) : null}
                <span className="asst-spacer" />
                <button className="asst-act" title="Copy">
                  <Icon name="copy" size={13} />
                </button>
                <button className="asst-act" title="Regenerate">
                  <Icon name="refresh" size={13} />
                </button>
              </div>
              {msg.reasoning && <ReasoningBlock text={msg.reasoning} streaming={!!msg.streaming} />}
              <div className="asst-body md">
                <AssistantBody
                  text={msg.streaming ? msg.shown || "" : msg.text}
                  streaming={!!msg.streaming && msg.text === ""}
                  onOpen={(bi) => onOpenBlock(i, bi)}
                />
                {msg.streaming && <span className="cursor" />}
              </div>
              {msg.memory && msg.memory.length > 0 && <MemoryNote facts={msg.memory} />}
            </div>
          )
        )}

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
  );
}
