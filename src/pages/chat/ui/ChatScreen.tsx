// ChatScreen.tsx — main chat page: owns the thread state, routing, streaming, the
// input composer, and the artifact-panel host. Renders the thread via a widget.
import { useEffect, useRef, useState } from "react";
import { ChatThread } from "@/widgets/chat-thread/ui/ChatThread";
import { ArtifactPanel } from "@/widgets/artifact-panel/ui/ArtifactPanel";
import { Icon } from "@/shared/ui/Icon";
import { PolicyIcon } from "@/entities/model/ui/PolicyIcon";
import { codeSegs } from "@/shared/lib/markdown";
import { route } from "@/features/route-request/model/route";
import { answerFor } from "@/shared/fixtures/demo";
import { SEED_MESSAGES } from "@/pages/chat/config/seed";
import { SYSTEM_PROMPT, SUMMARY_PROMPT, MEMORY_EXTRACT_PROMPT } from "@/shared/config/prompts";
import { estimateTokens, ctxTokens } from "@/shared/lib/tokens";
import { costOf } from "@/entities/model/lib/pricing";
import { POLICIES, PROVIDERS, type Message, type Decision, type PolicyId, type ImageRef } from "@/entities/model/model/registry";
import type { ChatMsg, Delta, Backend, ModelOption } from "@/entities/model/model/backend";
import { CODEX_MODELS, anthropicEffortTier, EFFORT_LEVELS, resolveEffort, type EffortLevel } from "@/entities/model/model/apiIds";
import { pickBackend, pickSummarizerBackend, listAvailableModels, peekAvailableModels } from "@/features/pick-backend/model/pickBackend";
import { streamLLM } from "@/features/stream-completion/model/streamLLM";
import { memoryBlock, getMemories, addMemory } from "@/entities/memory/model/memory";
import { extractMemories } from "@/pages/chat/model/extractMemories";
import { humanizeError } from "@/shared/lib/errors";
import {
  extractAndSave,
  redactCode,
  referencedIds,
  loadArtifact,
  artifactLang,
  largeBlockIds,
  makeArtifact,
  rememberArtifactTitle,
  isLargePaste,
  wrapFence,
  type Artifact,
} from "@/entities/artifact/model/artifacts";
import { readDataUrl, readText } from "@/pages/chat/lib/files";
import { getChats, loadChatBody, saveChatBody, upsertChat, indexEntryFrom } from "@/entities/chat/model/chats";

// What the right panel is showing: a static artifact (a composer chip preview, not
// yet in the thread) or a live locator into a thread message's Nth code block.
type OpenRef = { kind: "static"; art: Artifact } | { kind: "msg"; msgIndex: number; blockIndex: number };

// Live-resolve the Nth code block of a (possibly still streaming) message, so the
// open ArtifactPanel re-derives its content on every token without a click.
function resolveBlock(msg: Message | undefined, blockIndex: number): Artifact | null {
  if (!msg) return null;
  const body = msg.streaming ? msg.shown || "" : msg.text;
  const c = codeSegs(body)[blockIndex];
  return c ? makeArtifact(c.lang, c.code) : null;
}

// Name the model that actually answered, not the routed pick — pickBackend may run
// an OpenAI route on a ChatGPT account or fall back. Override only when they diverge.
function backendBadge(backend: Backend, decision: Decision): { label: string; provider: string } | undefined {
  const provider = backend.kind === "anthropic" ? "anthropic" : "openai";
  if (provider === decision.chosen.provider && backend.kind !== "chatgpt") return undefined;
  const codex = CODEX_MODELS.find((m) => m.id === backend.model);
  return { label: codex?.name ?? backend.label ?? backend.model, provider };
}

// Time-of-day greeting for the new-chat hero.
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function ChatScreen({
  policy,
  setPolicy,
  chatId,
  showDemo = false,
}: {
  policy: PolicyId;
  setPolicy: (p: PolicyId) => void;
  chatId: string;
  showDemo?: boolean;
}) {
  // Show the scripted demo thread only on the startup chat of a first-ever launch
  // (no saved chats yet); "New chat" and opened chats never seed it.
  const demo = showDemo && getChats().length === 0;
  const [messages, setMessages] = useState<Message[]>(demo ? SEED_MESSAGES : []);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "routing" | "streaming">("idle");
  const createdAt = useRef(Date.now());
  const dirty = useRef(false); // set on first user action; gates persistence (don't index the demo)
  const [modelSel, setModelSel] = useState<ModelOption | null>(null); // null = Auto (routed)
  const [summary, setSummary] = useState(""); // compressed brief of old turns (context compaction)
  const [covered, setCovered] = useState(0); // count of leading messages already folded into `summary`
  const [compacting, setCompacting] = useState(false); // background context summarization in flight
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinking, setThinking] = useState(false); // request the model's reasoning trace
  const [effort, setEffort] = useState<EffortLevel | "auto">("auto"); // Anthropic effort, "auto" = per-model default
  const [effortOpen, setEffortOpen] = useState(false); // effort flyout (CSS-anchored to its row)
  const effortTimer = useRef<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelPickRef = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<ModelOption[]>(peekAvailableModels);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [openRef, setOpenRef] = useState<OpenRef | null>(null); // which artifact the right panel shows (overrides routing)
  const [attachments, setAttachments] = useState<Artifact[]>([]); // pending pasted blobs / text files → artifact chips
  const [images, setImages] = useState<ImageRef[]>([]); // pending image attachments (vision) → thumbnails in the composer
  const [dragging, setDragging] = useState(false); // drag-over highlight for file drop
  const fileRef = useRef<HTMLInputElement>(null); // hidden file picker behind the attach button

  const busy = phase !== "idle";

  // Load this chat's saved body on mount.
  useEffect(() => {
    let alive = true;
    const existing = getChats().find((c) => c.id === chatId);
    if (existing) createdAt.current = existing.createdAt; // keep the original creation time
    loadChatBody(chatId).then((body) => {
      if (!alive || !body) return;
      setMessages(body.messages);
      setSummary(body.summary);
      setCovered(body.covered);
    });
    return () => {
      alive = false;
    };
  }, [chatId]);

  // Persist after each turn settles (skip while streaming and until the user acts, so
  // the demo thread isn't indexed). Debounced to coalesce the burst of state updates.
  useEffect(() => {
    if (!dirty.current || phase !== "idle") return;
    const entry = indexEntryFrom(chatId, messages, createdAt.current);
    if (!entry) return;
    const t = setTimeout(() => {
      void saveChatBody(chatId, { messages, summary, covered });
      upsertChat(entry);
    }, 400);
    return () => clearTimeout(t);
  }, [messages, summary, covered, phase, chatId]);

  // Fetch the live model list each time the picker opens, so it reflects what the
  // connected backends actually accept (and a freshly-connected provider shows up).
  useEffect(() => {
    if (!modelMenuOpen) return;
    let alive = true;
    // Seed from cache so a warm list shows instantly; only spin when nothing's cached.
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

  // Close the model menu on an outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (modelPickRef.current && !modelPickRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelMenuOpen]);

  // Collapse the effort flyout whenever the model menu closes.
  useEffect(() => {
    if (!modelMenuOpen) setEffortOpen(false);
  }, [modelMenuOpen]);

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 260) + "px";
  }

  // Attach dropped/picked/pasted files: images → vision thumbnails, everything else
  // → a text artifact chip (titled with the real filename). Binary non-images are skipped.
  async function addFiles(files: ArrayLike<File>) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const url = await readDataUrl(file).catch(() => "");
        const data = url.split(",")[1];
        if (!data) continue;
        setImages((p) => (p.some((x) => x.dataUrl === url) ? p : [...p, { name: file.name, mime: file.type, data, dataUrl: url }]));
      } else {
        const text = await readText(file).catch(() => "");
        if (!text.trim() || text.indexOf(String.fromCharCode(0)) !== -1) continue; // empty or binary → skip
        const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
        const art = makeArtifact(ext, text, file.name);
        rememberArtifactTitle(art.id, file.name); // keep the filename as the title after send → re-render
        setAttachments((a) => (a.some((x) => x.id === art.id) ? a : [...a, art]));
      }
    }
  }

  // Compress stale turns into a brief via the cheapest available backend, so a
  // long chat stays inside the window even after switching to a small-ctx model.
  // Returns "" when offline/failed — the caller then just sends recent turns.
  async function summarize(prior: string, stale: Message[]): Promise<string> {
    // Prefer a flat-fee subscription account (free per call); else the cheapest key.
    const sb = pickSummarizerBackend(route(SUMMARY_PROMPT, "cost"));
    if (sb.kind === "none") return "";
    // Swap large code blocks for [[id]] tokens — code is stored verbatim as artifacts,
    // not paraphrased. The summarizer keeps only the tokens still relevant.
    const transcript = stale.map((m) => `${m.role}: ${redactCode(m.text).text}`).join("\n");
    const prompt = SUMMARY_PROMPT + (prior ? `Previous summary:\n${prior}\n\n` : "") + transcript;
    let out = "";
    try {
      for await (const d of streamLLM(sb, [{ role: "user", content: prompt }])) {
        if (d.kind === "text") out += d.text;
      }
    } catch {
      return "";
    }
    return out.trim();
  }

  // Summarize old turns off the critical path: this turn still sends the current
  // (longer) history, but the result is ready for the next turn — no added latency.
  function compactInBackground(hist: Message[], cov: number, prior: string, keep: number) {
    setCompacting(true);
    summarize(prior, hist.slice(cov, hist.length - keep))
      .then((fresh) => {
        if (fresh) {
          setSummary(fresh);
          setCovered(hist.length - keep);
        }
      })
      .finally(() => setCompacting(false));
  }

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0 && images.length === 0) || busy) return;
    dirty.current = true; // user acted → this chat is now worth persisting
    // Fold pasted attachments back into the message as fenced blocks: the existing
    // UserContent renders them as cards, history/threading carry them verbatim, and
    // extractAndSave persists them — no Message-shape change needed.
    const fullText = [text, ...attachments.map((a) => wrapFence(a.lang, a.code))].filter(Boolean).join("\n\n");
    const imgs = images;
    setInput("");
    setAttachments([]);
    setImages([]);
    setTimeout(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    }, 0);

    // An attached image forces a vision-capable model regardless of policy.
    const decision = route(fullText, policy, { requireVision: imgs.length > 0 });
    // Snapshot history (before the new turn) for the API call.
    const history = messages;
    setMessages((m) => [...m, { role: "user", text: fullText, images: imgs.length ? imgs : undefined }]);
    void extractAndSave(fullText); // persist large code blocks as artifacts (fire-and-forget)
    setPhase("routing");

    const backend = modelSel ? modelSel.backend : pickBackend(decision);
    const manual = modelSel ? { label: modelSel.label, provider: modelSel.provider } : backendBadge(backend, decision);
    if (backend.kind === "none") {
      // No key configured — fall back to the scripted demo answer.
      setTimeout(() => {
        setPhase("streaming");
        const full = answerFor(fullText);
        setMessages((m) => [...m, { role: "assistant", text: full, decision, shown: "", streaming: true }]);
        streamOut(full, decision);
      }, 950);
      return;
    }

    // Keep the conversation inside the window. Budget by the routed pick's ctx —
    // a stable proxy for the active model. Soft threshold (50%) → compact in the
    // background for the *next* turn so this answer isn't delayed. Hard threshold
    // (85%) → compact synchronously now, to avoid overflowing the window.
    let sumText = summary;
    let cov = covered;
    const KEEP = 6; // last messages always sent verbatim
    const win = ctxTokens(decision.chosen.ctx);
    const used = history.reduce((n, m) => n + estimateTokens(m.text), estimateTokens(sumText));
    const canCompact = history.length - KEEP > cov;
    if (used > win * 0.85 && canCompact) {
      const fresh = await summarize(sumText, history.slice(cov, history.length - KEEP));
      if (fresh) {
        sumText = fresh;
        cov = history.length - KEEP;
        setSummary(fresh);
        setCovered(cov);
      }
    } else if (used > win * 0.5 && canCompact && !compacting) {
      compactInBackground(history, cov, sumText, KEEP); // readies the summary for the next turn
    }

    // Re-inject verbatim only the artifacts the summary still references (and that
    // aren't already in the recent verbatim window). Bounded by a token cap so a
    // long chat can't blow the window; dropped (oldest-first) ids are logged.
    const recent: ChatMsg[] = history
      .slice(cov)
      .map((m) => ({ role: m.role, content: m.text, images: m.images?.map((im) => ({ mime: im.mime, data: im.data })) }));
    const inRecent = new Set(recent.flatMap((m) => largeBlockIds(m.content)));
    const wanted = [...new Set(referencedIds(sumText))].filter((id) => !inRecent.has(id));
    let codeBudget = win * 0.3;
    const blocks: string[] = [];
    for (const id of wanted) {
      const code = await loadArtifact(id);
      if (code == null) continue; // summarizer invented/garbled an id — skip
      const block = `[[${id}]]\n${wrapFence(artifactLang(id), code)}`;
      const t = estimateTokens(block);
      if (t > codeBudget) {
        console.warn(`[artifacts] dropping ${id} from context (appendix budget exceeded)`);
        continue;
      }
      codeBudget -= t;
      blocks.push(block);
    }
    const codeAppendix = blocks.length
      ? `\n\nReferenced code artifacts (verbatim, do not summarize):\n${blocks.join("\n\n")}`
      : "";

    // Long-term memory first (durable facts about the user), then the per-chat summary.
    const mem = memoryBlock();
    const sysContent =
      SYSTEM_PROMPT +
      (mem ? `\n\nWhat you remember about the user:\n${mem}` : "") +
      (sumText ? `\n\nSummary of earlier conversation:\n${sumText}` : "") +
      codeAppendix;
    const userMsg: ChatMsg = { role: "user", content: fullText, images: imgs.length ? imgs.map((im) => ({ mime: im.mime, data: im.data })) : undefined };
    realSend(decision, [{ role: "system", content: sysContent }, ...recent, userMsg], backend, manual, thinking, effort, fullText);
  }

  // Real OpenAI streaming. Stays in the "routing" (analyzing) phase until the
  // first token arrives, then streams tokens into the assistant message.
  async function realSend(
    decision: Decision,
    apiMessages: ChatMsg[],
    backend: Backend,
    manual: { label: string; provider: string } | undefined,
    reasoningOn: boolean,
    effortLevel: EffortLevel | "auto",
    userText: string
  ) {
    let acc = "";
    let reason = "";
    let usage: Extract<Delta, { kind: "usage" }> | undefined;
    const t0 = performance.now();
    let started = false;
    const begin = () => {
      started = true;
      setPhase("streaming");
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "", decision, shown: "", streaming: true, modelLabel: manual?.label, modelProvider: manual?.provider },
      ]);
    };
    const update = () => {
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last && last.streaming) copy[copy.length - 1] = { ...last, shown: acc, reasoning: reason || undefined };
        return copy;
      });
    };

    try {
      for await (const delta of streamLLM(backend, apiMessages, reasoningOn, effortLevel)) {
        if (!started) begin();
        if (delta.kind === "usage") usage = delta;
        else if (delta.kind === "thinking") reason += delta.text;
        else acc += delta.text;
        update();
      }
      if (!started) begin(); // empty completion — still show an assistant turn
      // Real measured stats; fall back to text estimates if the stream gave no usage.
      const latencyMs = performance.now() - t0;
      const u = usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }
        : { inputTokens: estimateTokens(apiMessages.map((mm) => mm.content).join("\n")), outputTokens: estimateTokens(acc) };
      const cost = usage?.metered ? costOf(backend.model, u) : undefined; // $ only for metered turns
      let asstIndex = -1; // this turn's assistant message; stable since we only append
      setMessages((m) => {
        const copy = m.slice();
        asstIndex = copy.length - 1;
        const last = copy[asstIndex];
        if (last) copy[asstIndex] = { ...last, text: acc, shown: acc, reasoning: reason || undefined, streaming: false, usage: u, latencyMs, cost };
        return copy;
      });
      if (acc.trim()) void extractAndSave(acc); // persist any large code the model returned
      // Long-term memory: extract durable user facts from this finished turn, off the
      // critical path (like background compaction). Uses a flat-fee/cheap backend; the
      // store dedups (addMemory returns false on a repeat), so we tag the message only
      // with the facts actually stored — that drives the "Memory updated" note.
      if (acc.trim()) {
        void extractMemories(userText, acc, getMemories(), pickSummarizerBackend(route(MEMORY_EXTRACT_PROMPT, "cost")))
          .then((facts) => {
            const added = facts.filter((f) => addMemory(f.text, f.kind)).map((f) => f.text);
            if (!added.length || asstIndex < 0) return;
            setMessages((m) => {
              if (!m[asstIndex]) return m;
              const copy = m.slice();
              copy[asstIndex] = { ...copy[asstIndex], memory: added };
              return copy;
            });
          })
          .catch(() => {});
      }
    } catch (err) {
      const msg = `⚠️ ${humanizeError(err instanceof Error ? err.message : "Request failed")}`;
      if (!started) begin();
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last) copy[copy.length - 1] = { ...last, text: msg, shown: msg, streaming: false };
        return copy;
      });
    } finally {
      setPhase("idle");
    }
  }

  function streamOut(full: string, decision: Decision) {
    // Offline demo has no real usage — estimate from text (input ≈ routing estimate).
    const estIn = decision.tokens;
    const estOut = estimateTokens(full);
    let i = 0;
    const step = Math.max(2, Math.round(full.length / 90)); // ~90 frames
    const tick = () => {
      i = Math.min(full.length, i + step);
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last && last.streaming) copy[copy.length - 1] = { ...last, shown: full.slice(0, i) };
        return copy;
      });
      if (i < full.length) {
        setTimeout(tick, 18);
      } else {
        setMessages((m) => {
          const copy = m.slice();
          const last = copy[copy.length - 1];
          // Tag with estimated usage (no real cost) so the header shows tokens, no $.
          if (last) copy[copy.length - 1] = { ...last, shown: full, streaming: false, usage: { inputTokens: estIn, outputTokens: estOut }, latencyMs: undefined };
          return copy;
        });
        setPhase("idle");
      }
    };
    setTimeout(tick, 30);
  }

  // A fresh, empty chat → centered greeting + composer (AI-workspace style).
  const isNewChat = messages.length === 0 && phase === "idle";

  // Effort selector visibility/levels. An explicit Anthropic pick uses its model's tier;
  // Auto shows the safe low/med/high set when any connected model is Anthropic. The send
  // path (resolveEffort) is the final gate, so the displayed set can be conservative.
  const effTier = modelSel?.provider === "anthropic" ? anthropicEffortTier(modelSel.backend.model) : null;
  const showEffort = modelSel ? !!effTier : options.some((o) => o.provider === "anthropic");
  const effortLevels = effTier ? EFFORT_LEVELS[effTier] : EFFORT_LEVELS.sonnet;
  const activeEffort = resolveEffort(effTier ?? "sonnet", effort);
  // The flyout is CSS-anchored to its row (.effort-item is the positioned parent); no JS
  // coords — the app uses zoom, which throws off fixed positioning + getBoundingClientRect.
  // A short close delay lets the pointer cross the gap into the flyout.
  const openEffortFly = () => {
    if (effortTimer.current) window.clearTimeout(effortTimer.current);
    effortTimer.current = null;
    setEffortOpen(true);
  };
  const closeEffortFly = () => {
    effortTimer.current = window.setTimeout(() => setEffortOpen(false), 120);
  };

  const canSend = !!(input.trim() || attachments.length || images.length);

  // The input block, rendered either centered (new chat) or pinned to the bottom.
  const composer = (
    <>
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
        readOnly={busy}
        className={busy ? "working" : ""}
        placeholder={busy ? "Working on your request…" : "Ask anything — the router picks the model."}
        rows={1}
        onChange={(e) => {
          setInput(e.target.value);
          autosize();
        }}
        onPaste={(e) => {
          // Pasted file(s) — image (vision) or text/code (artifact chip) — go through addFiles.
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
            return;
          }
          // Big pastes (≥4 KB) become artifact chips instead of flooding the textarea.
          // A literal ``` inside the paste is fine — wrapFence sizes a longer outer fence.
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
          accept="image/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.cs,.css,.html,.yaml,.yml,.sql,.sh"
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = ""; // allow re-picking the same file
          }}
        />
        <button className="comp-tool" onClick={() => fileRef.current?.click()} title="Attach files or images">
          <Icon name="plus" size={17} />
        </button>
        <span className="comp-div" />
        <div className="policy-selector">
          {(Object.keys(POLICIES) as PolicyId[]).map((k) => (
            <PolicyIcon key={k} policy={k} active={policy === k} onClick={() => setPolicy(k)} compact />
          ))}
        </div>
        <div className="model-pick-wrap" ref={modelPickRef}>
          <button
            className={"model-pick" + (modelSel ? " on" : "")}
            onClick={() => setModelMenuOpen((v) => !v)}
            title="Choose which model answers"
          >
            <Icon name="providers" size={13} />
            <span className="model-pick-label">{modelSel ? modelSel.label : "Auto"}</span>
            <Icon name="chevron" size={10} style={{ transform: "rotate(90deg)", opacity: 0.6 }} />
          </button>
          {modelMenuOpen && (
            <div className="model-menu">
              <div className="model-menu-scroll">
                <button
                  className={"model-menu-item" + (!modelSel ? " on" : "")}
                  onClick={() => {
                    setModelSel(null);
                    setModelMenuOpen(false);
                  }}
                >
                  <span className="model-menu-dot" style={{ background: "var(--accent)" }} />
                  <span style={{ flex: 1 }}>
                    Auto <span className="model-menu-sub">routed by policy</span>
                  </span>
                  {!modelSel && <Icon name="check" size={12} />}
                </button>
                {modelsLoading && <div className="model-menu-empty">Loading models…</div>}
                {!modelsLoading && options.length === 0 && (
                  <div className="model-menu-empty">Connect a provider to pick a model.</div>
                )}
                {options.map((o) => (
                  <button
                    key={o.key}
                    className={"model-menu-item" + (modelSel?.key === o.key ? " on" : "")}
                    onClick={() => {
                      setModelSel(o);
                      setModelMenuOpen(false);
                    }}
                  >
                    <span className="model-menu-dot" style={{ background: PROVIDERS[o.provider]?.color }} />
                    <span style={{ flex: 1 }}>{o.label}</span>
                    {modelSel?.key === o.key && <Icon name="check" size={12} />}
                  </button>
                ))}
              </div>
              <div className="model-menu-sep" />
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
              {showEffort && (
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
                          onClick={() => {
                            setEffort(lvl);
                            setEffortOpen(false);
                          }}
                        >
                          <span style={{ textTransform: "capitalize" }}>{lvl}</span>
                          <span className="effort-check">{activeEffort === lvl && <Icon name="check" size={12} />}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        <button
          className={"send-btn" + (busy ? " stop" : canSend ? " on" : "")}
          onClick={busy ? undefined : send}
          disabled={!busy && !canSend}
          title={busy ? "Working…" : "Send"}
        >
          {busy ? <span className="send-stop" /> : <Icon name="send" size={16} />}
        </button>
      </div>
    </div>
    </>
  );

  const firstUser = messages.find((m) => m.role === "user");
  const title = firstUser ? firstUser.text : "New chat";

  // Resolve the open artifact live from current state (so a streaming block updates
  // the panel in real time), and whether *that* block is still being generated.
  const openMsg = openRef?.kind === "msg" ? messages[openRef.msgIndex] : undefined;
  const openArt = !openRef ? null : openRef.kind === "static" ? openRef.art : resolveBlock(openMsg, openRef.blockIndex);
  const openGenerating =
    openRef?.kind === "msg" && !!openMsg?.streaming && openMsg.text === "" && !!codeSegs(openMsg.shown || "")[openRef.blockIndex]?.open;

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
              {title}
            </span>
            <span className="chat-top-meta">{messages.length} messages</span>
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
              onOpenBlock={(mi, bi) => setOpenRef({ kind: "msg", msgIndex: mi, blockIndex: bi })}
            />
            <div className="composer-wrap">{composer}</div>
          </>
        )}
      </div>

      {openArt ? (
        <ArtifactPanel artifact={openArt} onClose={() => setOpenRef(null)} generating={openGenerating} />
      ) : null}
    </div>
  );
}
