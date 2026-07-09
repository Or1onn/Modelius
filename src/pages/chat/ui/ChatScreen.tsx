// ChatScreen.tsx — chat page view: composer, model picker, artifact-panel host. Thread via widget.
import { Fragment, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ChatThread } from "@/widgets/chat-thread/ui/ChatThread";
import { ArtifactPanel } from "@/widgets/artifact-panel/ui/ArtifactPanel";
import { Icon } from "@/shared/ui/Icon";
import { ProviderLogo } from "@/entities/model/ui/ProviderLogo";
import { codeSegs } from "@/shared/lib/markdown";
import { PROVIDERS, type Message, type PolicyId, type ImageRef } from "@/entities/model/model/registry";
import type { ModelOption } from "@/entities/model/model/backend";
import { anthropicEffortTier, ctxForBackend, EFFORT_LEVELS, resolveEffort, type EffortLevel } from "@/entities/model/model/apiIds";
import { estimateTokens, ctxTokens, fmtCompact } from "@/shared/lib/tokens";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { useAutosize } from "@/shared/lib/useAutosize";
import { listAvailableModels, peekAvailableModels, optionAllowsImages, optionAllowsWeb } from "@/features/pick-backend/model/pickBackend";
import { supportsReasoning } from "@/entities/model/lib/pricingSource";
import { makeArtifact, rememberArtifactTitle, isLargePaste, wrapFence, type Artifact } from "@/entities/artifact/model/artifacts";
import { collectVersions } from "@/entities/artifact/lib/versions";
import { ExportButton } from "@/features/export-chat/ui/ExportButton";
import { readDataUrl, readText } from "@/pages/chat/lib/files";
import { getChats } from "@/entities/chat/model/chats";
import { useSession, sendMessage, stopStream, regenerate, editAndResend, continueMessage, switchBranch, setChatPrompt } from "@/pages/chat/model/sessionStore";
import { getDraft, setDraft, clearDraft } from "@/pages/chat/model/drafts";
import { getModelSel, setModelSel as persistModelSel } from "@/pages/chat/model/modelSel";

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

// ProviderLogo props for a model option: OpenRouter rows resolve the icon to the id's vendor
// brand (e.g. "anthropic/claude-…" → Claude); everything else uses the provider's own logo.
function vendorOf(o: ModelOption): { pid: string; short: string; modelId?: string } {
  if (o.provider === "openrouter" && o.backend.model.includes("/")) {
    const vendor = o.backend.model.replace(/^~/, "").split("/")[0];
    return { pid: o.provider, short: vendor.slice(0, 2).toUpperCase(), modelId: o.backend.model };
  }
  return { pid: o.provider, short: PROVIDERS[o.provider]?.short ?? "?" };
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
  const [input, setInput] = useState(() => getDraft(chatId)); // restore unsent draft on chat/screen switch
  // Persist the manual pick per-chat so it survives a chat/screen switch (like drafts).
  const [modelSel, setModelSelState] = useState<ModelOption | null>(() => getModelSel(chatId));
  const setModelSel = (sel: ModelOption | null) => {
    persistModelSel(chatId, sel);
    setModelSelState(sel);
  };
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState(""); // search filter in the picker
  const [thinking, setThinking] = useState(false); // request the reasoning trace
  const [web, setWeb] = useState(true); // server-side web search — on by default
  const [addMenuOpen, setAddMenuOpen] = useState(false); // composer "+" menu (files + web search)
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [effort, setEffort] = useState<EffortLevel | "auto">("auto"); // Anthropic effort, "auto" = per-model default
  const [effortOpen, setEffortOpen] = useState(false); // effort flyout
  const effortTimer = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelPickRef = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<ModelOption[]>(peekAvailableModels);
  const [modelsLoading, setModelsLoading] = useState(false);
  const PICKER_PAGE = 40; // reveal the list in pages (large providers like OpenRouter have 300+)
  const [pickerShown, setPickerShown] = useState(PICKER_PAGE);
  const [openRef, setOpenRef] = useState<OpenRef | null>(null); // artifact the right panel shows
  const [attachments, setAttachments] = useState<Artifact[]>([]); // pending pasted/dropped text → artifact chips
  const [images, setImages] = useState<ImageRef[]>([]); // pending image attachments (vision)
  const [dragging, setDragging] = useState(false); // drag-over highlight
  const [noModel, setNoModel] = useState(false); // tried to send with nothing connected
  const fileRef = useRef<HTMLInputElement>(null); // hidden file picker

  const busy = phase !== "idle";

  // Refetch the live model list each time the picker opens (reflects newly-connected providers).
  useEffect(() => {
    if (!modelMenuOpen) return;
    let alive = true;
    // Seed from cache for an instant warm list; spin only when nothing's cached.
    const seed = peekAvailableModels();
    if (seed.length) setOptions(seed);
    setModelsLoading(seed.length === 0);
    listAvailableModels()
      .then((o) => alive && setOptions(o))
      .finally(() => alive && setModelsLoading(false));
    return () => {
      alive = false;
    };
  }, [modelMenuOpen]);

  // Close the model menu / composer "+" menu on an outside click.
  useOutsideClick(modelPickRef, modelMenuOpen, () => setModelMenuOpen(false));
  useOutsideClick(addMenuRef, addMenuOpen, () => setAddMenuOpen(false));

  // Collapse the effort flyout and clear the search whenever the model menu closes.
  useEffect(() => {
    if (!modelMenuOpen) {
      setEffortOpen(false);
      setModelQuery("");
    }
  }, [modelMenuOpen]);

  // Default a reopened chat to its last manually-used model: the in-memory pick is lost on restart,
  // but assistant turns record the model on the message. Restore once, only if nothing is picked.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current === chatId) return;
    if (modelSel || getModelSel(chatId)) {
      restoredFor.current = chatId; // already has an explicit pick this session
      return;
    }
    if (loading || options.length === 0) return; // wait for history + the live model list
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.modelLabel);
    const match = last && options.find((o) => o.label === last.modelLabel && o.provider === last.modelProvider);
    if (match) setModelSel(match);
    restoredFor.current = chatId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, options, messages, loading]);

  // Group the list by connection: a Codex (ChatGPT) account, else the provider's display name.
  // Options arrive already blocked per provider, so a header is shown wherever the group changes.
  const groupKey = (o: ModelOption) => (o.backend.kind === "chatgpt" ? "codex" : o.provider);
  const groupName = (o: ModelOption) =>
    o.backend.kind === "chatgpt" ? "Codex" : PROVIDERS[o.provider]?.name ?? o.provider;

  // Filter the live model list by the search query (matches model name, provider id, and group name).
  // Memoized — large lists (OpenRouter: 300+) would otherwise re-filter on every unrelated render.
  const q = modelQuery.trim().toLowerCase();
  const filteredOptions = useMemo(
    () => (q ? options.filter((o) => (o.label + " " + o.provider + " " + groupName(o)).toLowerCase().includes(q)) : options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, q]
  );
  const autoMatches = !q || "auto routed by policy".includes(q);

  // On open with no search, page far enough to include the selected model and flag it for scroll-into-view;
  // while searching (or with no pick) restart paging from the top.
  const pickerScrollPending = useRef(false);
  useEffect(() => {
    if (modelMenuOpen && !q && modelSel) {
      const idx = options.findIndex((o) => o.key === modelSel.key);
      if (idx >= 0) {
        setPickerShown(Math.max(PICKER_PAGE, idx + PICKER_PAGE));
        pickerScrollPending.current = true;
        return;
      }
    }
    setPickerShown(PICKER_PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelMenuOpen, q]);
  const onPickerScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 32) {
      setPickerShown((n) => (n < filteredOptions.length ? n + PICKER_PAGE : n));
    }
  };

  const autosize = useAutosize(taRef, 260);

  // Restore the textarea height for a draft restored on mount/chat-switch.
  useEffect(autosize, [chatId]);

  // Attach files: images → vision thumbnails, else → text artifact chip. Binary non-images skipped.
  async function addFiles(files: ArrayLike<File>) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        if (!imagesAllowed) continue; // selected model can't read images — ignore it
        const url = await readDataUrl(file).catch(() => "");
        const data = url.split(",")[1];
        if (!data) continue;
        setImages((p) => (p.some((x) => x.dataUrl === url) ? p : [...p, { name: file.name, mime: file.type, data, dataUrl: url }]));
      } else {
        const text = await readText(file).catch(() => "");
        if (!text.trim() || text.indexOf(String.fromCharCode(0)) !== -1) continue; // empty or binary → skip
        const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
        const art = makeArtifact(ext, text, file.name);
        rememberArtifactTitle(art.id, file.name); // keep filename as title after send
        setAttachments((a) => (a.some((x) => x.id === art.id) ? a : [...a, art]));
      }
    }
  }

  // Gather composer state and hand the turn to the session store (owns routing/streaming/etc).
  function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0 && images.length === 0) || busy) return;
    // No provider connected → don't fake an answer; prompt the user to connect a model.
    if (peekAvailableModels().length === 0) {
      setNoModel(true);
      return;
    }
    setNoModel(false);
    // Fold attachments into the message as fenced blocks — no Message-shape change needed.
    const fullText = [text, ...attachments.map((a) => wrapFence(a.lang, a.code))].filter(Boolean).join("\n\n");
    const imgs = images;
    setInput("");
    clearDraft(chatId);
    setAttachments([]);
    setImages([]);
    setTimeout(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    }, 0);
    sendMessage(chatId, { policy, modelSel, thinking, effort, web, fullText, images: imgs });
  }

  // Empty chat → centered greeting + composer. While a saved body is still loading,
  // hold off the hero so switching chats doesn't flash the new-chat page.
  const isNewChat = messages.length === 0 && phase === "idle" && !loading;

  // Effort selector visibility/levels. Explicit Anthropic pick → its model's tier; Auto →
  // safe low/med/high set when any connected model is Anthropic. resolveEffort is the final gate.
  const effTier = modelSel?.provider === "anthropic" ? anthropicEffortTier(modelSel.backend.model) : null;
  // OpenRouter reasoning models (e.g. Claude) accept low/medium/high effort too — only meaningful with
  // Thinking on. effortLevels/activeEffort fall back to the sonnet set (low/medium/high) when effTier is null.
  const orEffort = modelSel?.provider === "openrouter" && (supportsReasoning(modelSel.backend.model) ?? false) && thinking;
  const showEffort = modelSel ? !!effTier || orEffort : options.some((o) => o.provider === "anthropic");
  // Thinking toggle only for reasoning-capable models (per OpenRouter's catalog). A model unknown to
  // the catalog defaults to shown; the provider backends still gate the actual param. Auto → shown if
  // any connected model can reason.
  const reasoningOk = modelSel
    ? supportsReasoning(modelSel.backend.model) ?? true
    : options.some((o) => (supportsReasoning(o.backend.model) ?? true));
  // Drop a stale "on" state when switching to a model that can't reason.
  useEffect(() => {
    if (!reasoningOk) setThinking(false);
  }, [reasoningOk]);
  const effortLevels = effTier ? EFFORT_LEVELS[effTier] : EFFORT_LEVELS.sonnet;
  const activeEffort = resolveEffort(effTier ?? "sonnet", effort);
  // Thinking/Effort rows animate in/out (on model switch, and Effort when Thinking is toggled). The
  // rows stay mounted and collapse via a CSS grid transition, so each appears/disappears smoothly.
  const hasExtras = reasoningOk || showEffort;
  // Flyout is CSS-anchored to its row (no JS coords — app zoom breaks fixed positioning).
  // Short close delay lets the pointer cross the gap into the flyout.
  const openEffortFly = () => {
    if (effortTimer.current) window.clearTimeout(effortTimer.current);
    effortTimer.current = null;
    setEffortOpen(true);
  };
  const closeEffortFly = () => {
    effortTimer.current = window.setTimeout(() => setEffortOpen(false), 120);
  };

  // Images need a vision-capable model. Auto/unknown allow them; a known text-only pick blocks them.
  const imagesAllowed = optionAllowsImages(modelSel);
  // Drop staged images when switching to a model that can't read them.
  useEffect(() => {
    if (!imagesAllowed) setImages([]);
  }, [imagesAllowed]);

  // Web search needs a search-capable backend (Anthropic / Codex / OpenRouter / OpenAI Responses).
  const webAllowed = optionAllowsWeb(modelSel);
  // Drop a stale "on" when switching to a model that can't search.
  useEffect(() => {
    if (!webAllowed) setWeb(false);
  }, [webAllowed]);

  const canSend = !!(input.trim() || attachments.length || images.length);

  // Input block: centered (new chat) or pinned to the bottom.
  const composer = (
    <>
    {noModel && (
      <div className="no-model-notice">
        <Icon name="providers" size={15} />
        <span>No model connected — connect a provider to start chatting.</span>
        <button className="no-model-btn" onClick={() => onConnectModel?.()}>
          Connect a model
        </button>
      </div>
    )}
    <div
      className={"composer" + (busy ? " busy" : "") + (dragging ? " dragover" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      {(attachments.length > 0 || images.length > 0) && (
        <div className="composer-chips">
          {images.map((im, k) => (
            <div className="image-chip" key={"img" + k}>
              <img src={im.dataUrl} alt={im.name} title={im.name} />
              <button
                className="image-chip-x"
                onClick={() => setImages((p) => p.filter((_, j) => j !== k))}
                title="Remove"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
          {attachments.map((a) => (
            <div className="paste-chip" key={a.id}>
              <button className="paste-chip-body" onClick={() => setOpenRef({ kind: "static", art: a })} title="Preview artifact">
                <Icon name="code" size={13} />
                <span className="paste-chip-title">{a.title}</span>
              </button>
              <button
                className="paste-chip-x"
                onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}
                title="Remove"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={input}
        className={busy ? "working" : ""}
        placeholder={"Choose model and ask anything"}
        rows={1}
        onChange={(e) => {
          setInput(e.target.value);
          setDraft(chatId, e.target.value);
          autosize();
        }}
        onPaste={(e) => {
          // Pasted file(s) go through addFiles.
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
            return;
          }
          // Big pastes (≥4 KB) become artifact chips. Literal ``` is fine — wrapFence sizes a longer fence.
          const pasted = e.clipboardData.getData("text");
          if (isLargePaste(pasted)) {
            e.preventDefault();
            const art = makeArtifact("", pasted, "Pasted");
            setAttachments((a) => (a.some((x) => x.id === art.id) ? a : [...a, art]));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={(imagesAllowed ? "image/*," : "") + ".txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.cs,.css,.html,.yaml,.yml,.sql,.sh"}
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = ""; // allow re-picking same file
          }}
        />
        <div className="comp-add-wrap" ref={addMenuRef}>
          <button
            className={"comp-tool" + (addMenuOpen ? " on" : "")}
            onClick={() => setAddMenuOpen((v) => !v)}
            title="Add files, media, or web search"
          >
            <Icon name="plus" size={17} />
          </button>
          {addMenuOpen && (
            <div className="comp-add-menu">
              <button
                className="model-menu-item"
                onClick={() => {
                  setAddMenuOpen(false);
                  fileRef.current?.click();
                }}
              >
                <span className="model-menu-logo"><Icon name="attach" size={15} /></span>
                <span style={{ flex: 1 }}>{imagesAllowed ? "Files & media" : "Files"}</span>
              </button>
              <button
                className="model-menu-item"
                disabled={!webAllowed}
                onClick={() => webAllowed && setWeb((v) => !v)}
                title={webAllowed ? "Search the web for this turn" : "The selected model can't search the web"}
              >
                <span className="model-menu-logo"><Icon name="globe" size={15} /></span>
                <span style={{ flex: 1 }}>Web search</span>
                <span className="model-menu-check">{web && <Icon name="check" size={12} />}</span>
              </button>
            </div>
          )}
        </div>
        <span className="comp-div" />
        <div className="model-pick-wrap" ref={modelPickRef}>
          <button
            className={"model-pick" + (modelSel ? " on" : "")}
            onClick={() => setModelMenuOpen((v) => !v)}
            title="Choose which model answers"
          >
            {modelSel ? (
              <span
                className="model-pick-logo"
                style={{ color: PROVIDERS[modelSel.provider]?.color }}
              >
                <ProviderLogo {...vendorOf(modelSel)} />
              </span>
            ) : (
              <Icon name="providers" size={13} />
            )}
            <span className="model-pick-label">{modelSel ? modelSel.label : "Auto"}</span>
            <Icon name="chevron" size={10} style={{ transform: "rotate(90deg)", opacity: 0.6 }} />
          </button>
          {modelMenuOpen && (
            <div className="model-menu">
              <div className="model-menu-search">
                <Icon name="search" size={13} />
                <input
                  autoFocus
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="Search models…"
                  spellCheck={false}
                />
              </div>
              <div className="model-menu-scroll" onScroll={onPickerScroll}>
                {autoMatches && (
                  <button
                    className={"model-menu-item" + (!modelSel ? " on" : "")}
                    onClick={() => setModelSel(null)}
                  >
                    <span className="model-menu-logo">
                      <span className="model-menu-dot" style={{ background: "var(--accent)" }} />
                    </span>
                    <span style={{ flex: 1 }}>
                      Auto <span className="model-menu-sub">routed by policy</span>
                    </span>
                    <span className="model-menu-check">{!modelSel && <Icon name="check" size={12} />}</span>
                  </button>
                )}
                {modelsLoading && <div className="model-menu-empty">Loading models…</div>}
                {!modelsLoading && options.length === 0 && (
                  <div className="model-menu-empty">Connect a provider to pick a model.</div>
                )}
                {!modelsLoading && options.length > 0 && filteredOptions.length === 0 && !autoMatches && (
                  <div className="model-menu-empty">No models found.</div>
                )}
                {filteredOptions.slice(0, pickerShown).map((o, i, arr) => (
                  <Fragment key={o.key}>
                    {(i === 0 || groupKey(arr[i - 1]) !== groupKey(o)) && (
                      <div className="model-menu-group">{groupName(o)}</div>
                    )}
                    <button
                      ref={
                        modelSel?.key === o.key
                          ? (el) => {
                              if (el && pickerScrollPending.current) {
                                pickerScrollPending.current = false;
                                el.scrollIntoView({ block: "center" });
                              }
                            }
                          : undefined
                      }
                      className={"model-menu-item" + (modelSel?.key === o.key ? " on" : "")}
                      onClick={() => setModelSel(o)}
                    >
                      <span
                        className="model-menu-logo"
                        style={{ color: PROVIDERS[o.provider]?.color }}
                      >
                        <ProviderLogo {...vendorOf(o)} />
                      </span>
                      <span style={{ flex: 1 }}>{o.label}</span>
                      <span className="model-menu-check">{modelSel?.key === o.key && <Icon name="check" size={12} />}</span>
                    </button>
                  </Fragment>
                ))}
                {pickerShown < filteredOptions.length && (
                  <div className="model-menu-empty">Showing {pickerShown} of {filteredOptions.length} · scroll for more</div>
                )}
              </div>
              <div className={"model-menu-extras" + (hasExtras ? " open" : "")}>
                <div className="model-menu-extras-inner">
                  <div className="model-menu-sep" />
                  <div className={"menu-collapse" + (reasoningOk ? " open" : "")}>
                    <div className="menu-collapse-inner">
                      <button
                        className="model-menu-item split-row"
                        role="switch"
                        aria-checked={thinking}
                        onClick={() => setThinking((v) => !v)}
                      >
                        <span>Thinking</span>
                        <span className={"toggle" + (thinking ? " on" : "")}>
                          <span className="toggle-knob" />
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className={"menu-collapse" + (showEffort ? " open" : "")}>
                    <div className="menu-collapse-inner">
                      <div
                        className="effort-item"
                        onMouseEnter={openEffortFly}
                        onMouseLeave={closeEffortFly}
                      >
                        <button
                          className="model-menu-item split-row"
                          onClick={() => (effortOpen ? setEffortOpen(false) : openEffortFly())}
                        >
                          <span>Effort</span>
                          <span className="effort-val">
                            <span className="effort-current">{activeEffort}</span>
                            <Icon name="chevron" size={10} style={{ opacity: 0.6 }} />
                          </span>
                        </button>
                        {effortOpen && (
                          <div
                            className="effort-flyout"
                            onMouseEnter={openEffortFly}
                            onMouseLeave={closeEffortFly}
                          >
                            {effortLevels.map((lvl) => (
                              <button
                                key={lvl}
                                className={"model-menu-item" + (activeEffort === lvl ? " on" : "")}
                                onClick={() => setEffort(lvl)}
                              >
                                <span style={{ textTransform: "capitalize" }}>{lvl}</span>
                                <span className="effort-check">{activeEffort === lvl && <Icon name="check" size={12} />}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <button
          className={"send-btn" + (busy ? " stop" : canSend ? " on" : "")}
          onClick={busy ? () => stopStream(chatId) : send}
          disabled={!busy && !canSend}
          title={busy ? "Stop generating" : "Send"}
        >
          {busy ? <span className="send-stop" /> : <Icon name="send" size={16} />}
        </button>
      </div>
    </div>
    </>
  );

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

  // Resolve the open artifact live from current state, plus whether that block is still generating.
  const openMsg = openRef?.kind === "msg" ? messages[openRef.msgIndex] : undefined;
  const openArt = !openRef ? null : openRef.kind === "static" ? openRef.art : resolveBlock(openMsg, openRef.blockIndex);
  const openGenerating =
    openRef?.kind === "msg" && !!openMsg?.streaming && openMsg.text === "" && codeSegs(openMsg.shown || "")[openRef.blockIndex]?.open;

  // Version chain for the open artifact (by title, within this chat). Only for thread artifacts.
  const versionMap = useMemo(() => collectVersions(messages), [messages]);
  const openVersions =
    openRef?.kind === "msg" && openArt ? versionMap.get(openArt.title) ?? [] : [];
  const openVersionArts = openVersions.map((v) => v.art);
  const openVersionIndex =
    openRef?.kind === "msg"
      ? openVersions.findIndex((v) => v.msgIndex === openRef.msgIndex && v.blockIndex === openRef.blockIndex)
      : -1;

  return (
    <div className="chat-wrap">
      <div className="chat-main">
        {/* Top bar */}
        <header className="chat-top">
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
              <span
                className="ctx-meter"
                data-level={ctxMeter.pct >= 0.85 ? "high" : ctxMeter.pct >= 0.5 ? "mid" : "low"}
                title={`Context: ${Math.round(ctxMeter.used).toLocaleString()} / ${ctxMeter.win.toLocaleString()} tokens`}
              >
                <span className="ctx-meter-bar">
                  <span className="ctx-meter-fill" style={{ width: Math.min(100, ctxMeter.pct * 100) + "%" }} />
                </span>
                <span className="ctx-meter-label">
                  {fmtCompact(ctxMeter.used)} / {fmtCompact(ctxMeter.win)} · {Math.round(ctxMeter.pct * 100)}%
                </span>
              </span>
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
              onOpenBlock={(mi, bi) => setOpenRef({ kind: "msg", msgIndex: mi, blockIndex: bi })}
              onRegenerate={() => regenerate(chatId, { policy, modelSel, thinking, effort, web })}
              onEditResend={(mi, text) => editAndResend(chatId, mi, text, { policy, modelSel, thinking, effort, web })}
              onContinue={() => continueMessage(chatId, { policy, modelSel, thinking, effort, web })}
              siblings={siblings}
              onSwitchBranch={(p, dir) => switchBranch(chatId, p, dir)}
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
