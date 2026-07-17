// Composer.tsx — chat input block: textarea with per-chat drafts, attachment/image chips,
// "+" menu (files + web search), model picker with thinking/effort extras, send/stop.
// Rendered by ChatScreen in the new-chat hero or pinned to the bottom.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { ModelMenu } from "@/entities/model/ui/ModelMenu";
import { type PolicyId, type ImageRef } from "@/entities/model/model/registry";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { useAutosize } from "@/shared/lib/useAutosize";
import { peekAvailableModels } from "@/features/pick-backend/model/pickBackend";
import { makeArtifact, rememberArtifactTitle, isLargePaste, wrapFence, type Artifact } from "@/entities/artifact/model/artifacts";
import { readDataUrl, readText } from "@/pages/chat/lib/files";
import { sendMessage, stopStream } from "@/pages/chat/model/sessionStore";
import { getDraft, setDraft, clearDraft } from "@/pages/chat/model/drafts";
import type { ComposerModelState } from "@/pages/chat/model/useComposerModelState";

export function Composer({
  chatId,
  policy,
  busy,
  model,
  onConnectModel,
  onPreview,
}: {
  chatId: string;
  policy: PolicyId;
  busy: boolean;
  model: ComposerModelState;
  onConnectModel?: () => void;
  onPreview: (art: Artifact) => void; // open a staged artifact chip in the right panel
}) {
  const {
    modelSel,
    setModelSel,
    options,
    modelItems,
    modelsLoading,
    refreshModels,
    setModelMenuOpen,
    thinking,
    setThinking,
    web,
    setWeb,
    effort,
    setEffort,
    effortOpen,
    setEffortOpen,
    openEffortFly,
    closeEffortFly,
    effortLevels,
    activeEffort,
    hasExtras,
    reasoningOk,
    showEffort,
    imagesAllowed,
    webAllowed,
  } = model;

  const [input, setInput] = useState(() => getDraft(chatId)); // restore unsent draft on chat/screen switch
  const [addMenuOpen, setAddMenuOpen] = useState(false); // composer "+" menu (files + web search)
  const addMenuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<Artifact[]>([]); // pending pasted/dropped text → artifact chips
  const [images, setImages] = useState<ImageRef[]>([]); // pending image attachments (vision)
  const [dragging, setDragging] = useState(false); // drag-over highlight
  const [noModel, setNoModel] = useState(false); // tried to send with nothing connected
  const fileRef = useRef<HTMLInputElement>(null); // hidden file picker

  // Close the composer "+" menu on an outside click (ModelMenu handles its own).
  useOutsideClick(addMenuRef, addMenuOpen, () => setAddMenuOpen(false));

  const autosize = useAutosize(taRef, 260);

  // Restore the textarea height for a draft restored on mount/chat-switch.
  useEffect(autosize, [chatId]);

  // Drop staged images when switching to a model that can't read them.
  useEffect(() => {
    if (!imagesAllowed) setImages([]);
  }, [imagesAllowed]);

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

  const canSend = !!(input.trim() || attachments.length || images.length);

  return (
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
              <button className="paste-chip-body" onClick={() => onPreview(a)} title="Preview artifact">
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
        <ModelMenu
          items={modelItems}
          selectedKey={modelSel?.key ?? null}
          onSelect={(key) => setModelSel(options.find((o) => o.key === key) ?? null)}
          triggerLabel={modelSel ? modelSel.label : "Auto"}
          triggerPid={modelSel?.provider}
          triggerModelId={modelSel?.provider === "openrouter" ? modelSel.backend.model : undefined}
          closeOnSelect={false}
          loading={modelsLoading}
          onOpenChange={(o) => {
            setModelMenuOpen(o);
            if (!o) setEffortOpen(false);
          }}
          onRefresh={refreshModels}
          renderLeading={(mq) =>
            !mq || "auto routed by policy".includes(mq) ? (
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
            ) : null
          }
          extras={
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
          }
        />
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
}
