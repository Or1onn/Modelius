// CodeScreen.tsx — Code mode: a real agentic coding session. The user picks an Environment
// (an agentic CLI harness like Claude Code) + a Model + a workspace folder; the Rust `agent_run`
// command drives the harness and its raw output is decoded into an AI SDK message the transcript
// renders. Streaming state lives in a module-level Chat (codeChatRegistry) so a run survives a
// chat/screen switch.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "@/shared/ui/Icon";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { refreshUsage, useUsageLimits, useUsageFetching, useSpend } from "@/entities/session/model/usageLimits";
import { fmtReset, fmtUsd, winUsedPct } from "@/widgets/usage-meter/lib/format";
import { useAutosize } from "@/shared/lib/useAutosize";
import type { EffortLevel } from "@/entities/model/model/apiIds";
import { HARNESSES, HARNESS_BY_ID, PERMISSION_MODES, PERMISSION_LABEL, type NativeKind } from "@/entities/agent/model/harnesses";
import { useHarnessStatuses, refreshHarnessStatuses, installHarness, cliLoggedIn } from "@/entities/agent/model/harnessStatus";
import { hasAnthropicOAuth } from "@/entities/session/model/anthropicSession";
import { hasOpenAIOAuth } from "@/entities/session/model/openaiSession";
import { AuthModal } from "@/pages/code/ui/AuthModal";
import { choiceKey, codeContextTokens, defaultModelForHarness, type CodeModelChoice } from "@/entities/agent/model/codeModel";
import { ModelMenu, type ModelMenuItem } from "@/entities/model/ui/ModelMenu";
import { peekCodeModelGroups, listCodeModelGroups, type CodeModelGroup } from "@/entities/agent/model/codeModels";
import { clearModelCache } from "@/shared/lib/modelCache";
import { useGateways } from "@/entities/agent/model/gateways";
import { GatewayModal } from "@/pages/code/ui/GatewayModal";
import { listBranches, checkoutBranch } from "@/entities/agent/model/git";
import { getCodeChat, getCodeConfig, getCodeTitle, setCodeConfig, subscribeCodeConfig, isEmptyCodeChat, codeEffortInfo } from "@/features/run-agent/lib/codeChatRegistry";
import { fmtTokens } from "@/pages/code/model/codeUsage";
import { getTurnStatus, subscribeTurnStatus } from "@/features/run-agent/lib/turnStatus";
import { codeToMarkdown } from "@/features/export-chat/model/serializeCode";
import { copyToClipboard } from "@/features/export-chat/lib/save";
import { AssistantMessage } from "@/pages/code/ui/messageParts";
import { CodeStats, PLogo } from "@/pages/code/ui/CodeStats";
import { TerminalPanel } from "@/pages/code/ui/TerminalPanel";
import { useSettings } from "@/entities/settings/model/settings";
import { getRecentFolders, pushRecentFolder, getFolderBranch, setFolderBranch } from "@/pages/code/model/recentFolders";
import { basename } from "@/shared/lib/paths";
import { lastOfRole } from "@/shared/lib/lastOfRole";
import { readDataUrl } from "@/pages/chat/lib/files";

// A staged image attachment (base64 for the model, data URL for the chip thumbnail) — same shape
// as Chat's ImageRef.
interface StagedImage { name: string; mime: string; data: string; dataUrl: string }

const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max", ultra: "Ultra" };

// ---- small model badge (provider logo + name) ----
function badgePid(model: CodeModelChoice): string {
  if (model.kind === "anthropic") return "anthropic";
  if (model.kind === "codex") return "openai";
  if (model.kind === "kimi") return "moonshot";
  if (model.kind === "ollama") return "ollama";
  if (model.kind === "connected") return model.providerId;
  return "";
}

function ModelBadge({ model }: { model: CodeModelChoice }) {
  const pid = badgePid(model);
  const modelId = model.kind === "connected" ? model.id : undefined; // vendor-prefixed → resolves the real brand logo
  // Non-native picks run the CLI through the local gateway proxy — flag them wherever the badge
  // shows, so tool-calling quirks are traceable to the routing at a glance.
  const routed = model.kind !== "anthropic" && model.kind !== "codex" && model.kind !== "kimi";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {pid && <PLogo pid={pid} modelId={modelId} />}
      <span style={{ fontWeight: 520 }}>{model.label}</span>
      {routed && (
        <span style={{ fontSize: 11, color: "var(--text-3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>
          via gateway
        </span>
      )}
    </span>
  );
}

// ---- generic dropdown for the Environment / Model / Permission / folder / branch pickers ----
interface PickItem { id: string; label: string; sub?: string; check?: boolean; disabled?: boolean; subErr?: boolean; trailing?: ReactNode }
function Picker({ label, logo, items, onSelect, onOpen, down, btnClass, menuHeader, footer }: {
  label: string;
  logo?: ReactNode;
  items: PickItem[];
  onSelect: (id: string) => void;
  onOpen?: () => void;
  down?: boolean;
  btnClass?: string;
  menuHeader?: string;
  footer?: { label: string; onSelect: () => void };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, open, () => setOpen(false));
  return (
    <div className="cd-pick" ref={ref} style={{ position: "relative" }}>
      <button className={btnClass || "cd-model-pick"} onClick={() => { if (!open) onOpen?.(); setOpen((v) => !v); }} title={label}>
        {logo}
        <span style={{ fontWeight: 520 }}>{label}</span>
        <Icon name="chevronD" size={12} style={{ opacity: 0.55 }} />
      </button>
      {open && (
        <div className={"cd-pick-menu" + (down ? " down" : "")}>
          {menuHeader && <div className="cd-pick-head">{menuHeader}</div>}
          {items.map((it) => (
            <button
              key={it.id}
              className={"cd-pick-item" + (it.disabled ? " disabled" : "")}
              aria-disabled={it.disabled || undefined}
              onClick={() => { if (it.disabled) return; onSelect(it.id); setOpen(false); }}
            >
              <span className="cd-pick-label">
                <span className="cd-pick-name">{it.label}</span>
                {it.sub && <span className={"cd-pick-sub mono" + (it.subErr ? " err" : "")}>{it.sub}</span>}
              </span>
              {it.trailing ?? (it.check && <Icon name="check" size={15} />)}
            </button>
          ))}
          {footer && (
            <>
              <div className="cd-pick-div" />
              <button className="cd-pick-item cd-pick-action" onClick={() => { footer.onSelect(); setOpen(false); }}>
                <span className="cd-pick-label">{footer.label}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The account key this code chat's model bills against (for the usage meter). Native CLI logins map
// to their subscription account; a connected key uses its provider id. Others (gateway/Ollama) have
// no first-class usage surface here.
function codeProviderKey(model: CodeModelChoice): string | undefined {
  if (model.kind === "anthropic") return "anthropic";
  if (model.kind === "codex") return "chatgpt";
  if (model.kind === "connected") return model.providerId;
  return undefined;
}

// Context-window fill ring (Claude Code Desktop style): an arc that fills as the prompt grows.
function ContextRing({ tokens, limit, cost, modelName, providerKey, modelId }: { tokens: number; limit: number; cost: number | null; modelName: string; providerKey?: string; modelId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, open, () => setOpen(false));
  const snap = useUsageLimits(providerKey);
  const spend = useSpend(providerKey);
  const fetching = useUsageFetching(providerKey);
  const windows = snap?.windows ?? [];
  const balance = snap?.balanceUsd;
  useEffect(() => {
    if (open) void refreshUsage(providerKey, modelId);
  }, [open, providerKey, modelId]);
  const pct = limit > 0 ? Math.min(1, tokens / limit) : 0;
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <div className="cd-ctx" ref={ref} style={{ position: "relative" }}>
      <button className="cd-ctx-btn" onClick={() => setOpen((v) => !v)} onMouseEnter={() => void refreshUsage(providerKey, modelId)} title="Context & usage">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r={r} className="cd-ctx-track" fill="none" strokeWidth="2" />
          <circle
            cx="8" cy="8" r={r} className="cd-ctx-fill" fill="none" strokeWidth="2" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open && (
        <div className="cd-ctx-pop">
          <div className="cd-ctx-pop-model">{modelName}</div>
          <div className="cd-ctx-pop-row">
            <span>Context window</span>
            <span>{limit > 0 ? Math.round(pct * 100) + "%" : "—"}</span>
          </div>
          <div className="cd-ctx-bar"><span style={{ width: `${pct * 100}%` }} /></div>
          <div className="cd-ctx-pop-sub">
            {fmtTokens(tokens)} / {limit > 0 ? fmtTokens(limit) : "?"} tokens
          </div>

          {/* Probe in flight with nothing cached yet — show a placeholder, not an empty gap. */}
          {windows.length === 0 && fetching && (
            <div className="cd-ctx-plan">
              <div className="cd-ctx-plan-head">Plan usage limits</div>
              <div className="cd-ctx-pop-sub">Loading…</div>
            </div>
          )}

          {/* Subscription rate-limit windows, one labelled bar each (Claude Code's "Plan usage limits"). */}
          {windows.length > 0 && (
            <div className="cd-ctx-plan">
              <div className="cd-ctx-plan-head">Plan usage limits</div>
              {windows.map((w, i) => {
                const used = winUsedPct(w);
                const reset = fmtReset(w.resetsAt);
                const lvl = used == null ? undefined : used >= 90 ? "crit" : used >= 75 ? "warn" : undefined;
                return (
                  <div className="cd-ctx-win" key={i}>
                    <div className="cd-ctx-win-top">
                      <span className="cd-ctx-win-label">{w.label}</span>
                      <span className="cd-ctx-win-meta">
                        {reset && <em>{reset}</em>}
                        <b>{used != null ? `${used}%` : "—"}</b>
                      </span>
                    </div>
                    <div className="cd-ctx-bar" data-level={lvl}><span style={{ width: `${used ?? 0}%` }} /></div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Dollar figures: local run cost only for API-key chats (no plan windows); spend/balance when known. */}
          {cost != null && windows.length === 0 && (
            <div className="cd-ctx-pop-row" style={{ marginTop: 10 }}>
              <span>Usage</span>
              <span>{fmtUsd(cost)}</span>
            </div>
          )}
          {spend > 0 && (
            <div className="cd-ctx-pop-row"><span>Spent (Modelius)</span><span>{fmtUsd(spend)}</span></div>
          )}
          {balance && (
            <div className="cd-ctx-pop-row">
              <span>Balance</span>
              <span>{balance.limit != null ? `${fmtUsd(balance.usage)} / ${fmtUsd(balance.limit)}` : `${fmtUsd(balance.usage)} used`}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Last assistant message's metadata carries the prompt-token count + cumulative cost.
interface RunMeta { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; totalCostUsd?: number }

export function CodeScreen({ chatId }: { chatId: string }) {
  const chat = getCodeChat(chatId);
  const { messages, status, error, sendMessage, stop: stopChat } = useChat({ chat, throttle: 50 });
  const subscribe = useCallback((cb: () => void) => subscribeCodeConfig(chatId, cb), [chatId]);
  const getSnapshot = useCallback(() => getCodeConfig(chatId), [chatId]);
  const config = useSyncExternalStore(subscribe, getSnapshot);
  const { harness: harnessId, model, cwd, permissionMode, effort } = config;
  // Generated chat name (shares the config listener set); falls back to the first-message snippet.
  const genTitle = useSyncExternalStore(subscribe, useCallback(() => getCodeTitle(chatId), [chatId]));

  const [input, setInput] = useState("");
  // Staged attachments for the next turn: images (sent as native vision blocks) and files (sent by
  // absolute path — the agent reads them in place). Cleared on send.
  const [images, setImages] = useState<StagedImage[]>([]);
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  useOutsideClick(addMenuRef, addMenuOpen, () => setAddMenuOpen(false));
  // Bottom terminal: mounted only while open. Re-fitting a hidden xterm under the shell `zoom`
  // corrupts its grid, so closing tears it down and opening starts a fresh, correctly-fitted shell.
  const { zoom } = useSettings();
  const [termOpen, setTermOpen] = useState(false);
  // Command typed into the terminal right after it opens (the kimi login flow); a manual toggle
  // always starts a plain shell.
  const [termCmd, setTermCmd] = useState<string | null>(null);
  const toggleTerm = () => { setTermCmd(null); setTermOpen((v) => !v); };
  // A kimi turn that failed for want of a login (the Rust pump stamps such errors with a
  // `kimi login` hint): instead of surfacing the raw error, open the built-in terminal with the
  // login pre-typed — the user completes the device-code flow and just sends again.
  const kimiLoginNeeded =
    !!error && harnessId === "kimi-code" && /kimi login/.test(error.message ?? "");
  const handledLoginErr = useRef<unknown>(null);
  useEffect(() => {
    if (!kimiLoginNeeded || handledLoginErr.current === error) return;
    handledLoginErr.current = error; // one terminal per distinct failure, not per re-render
    setTermCmd("kimi login");
    setTermOpen(true);
  }, [kimiLoginNeeded, error]);
  const [recents, setRecents] = useState<string[]>(() => getRecentFolders());
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [modelGroups, setModelGroups] = useState<CodeModelGroup[]>(() => peekCodeModelGroups(harnessId));
  const [gatewaysOpen, setGatewaysOpen] = useState(false);
  const [authNeed, setAuthNeed] = useState<NativeKind | null>(null);
  const gateways = useGateways();
  const harnessStatuses = useHarnessStatuses();
  const harness = HARNESS_BY_ID[harnessId];
  // Effort picker for native picks whose harness supports it — the level list + default come
  // from the same helper the registry's resolvedEffort uses, so UI and CLI can't drift.
  const { levels: effortLevels, dflt: effortDefault } = codeEffortInfo(model);
  // Effective level shown/checked: an explicit pick, else the model default ("auto" tracks it).
  const activeEffort = effort !== "auto" && effortLevels?.includes(effort) ? effort : effortDefault;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // at bottom → follow the stream; scrolling up unpins so the user can read back
  const [atBottom, setAtBottom] = useState(true); // mirrors pinnedRef for the floating scroll-to-bottom button
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(false);
  const busy = status === "streaming" || status === "submitted";

  // Live turn status: the CLI's latest stderr line (retry/backoff), plus a silence detector —
  // long gaps between output lines (rate-limited / slow model start) would otherwise look like a
  // dead stall. A coarse ticker re-renders while busy so the silence hint can appear eventless.
  const turnStatus = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeTurnStatus(chatId, cb), [chatId]),
    useCallback(() => getTurnStatus(chatId), [chatId])
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, [busy]);
  const silentMs = turnStatus.activityAt ? Date.now() - turnStatus.activityAt : 0;
  const workNote = busy ? (turnStatus.note ?? (silentMs > 15_000 ? "waiting for the model…" : null)) : null;

  // Prompt-token fill + cost from the last assistant turn that carries usage — a cancelled or
  // errored turn may have no token metadata; falling back keeps the ring from resetting to 0.
  const lastMeta = lastOfRole(messages, "assistant", (m) => {
    const md = m.metadata as RunMeta | undefined;
    return md?.inputTokens != null || md?.cacheReadInputTokens != null || md?.cacheCreationInputTokens != null;
  })?.metadata as RunMeta | undefined;
  const contextTokens = lastMeta
    ? (lastMeta.inputTokens ?? 0) + (lastMeta.cacheReadInputTokens ?? 0) + (lastMeta.cacheCreationInputTokens ?? 0)
    : 0;
  const cost = lastMeta?.totalCostUsd ?? null;
  const active = messages.length > 0; // a started session: fold the folder strip into a top bar
  const chatTitle = active ? genTitle || userText(messages.find((m) => m.role === "user") as any) : "";

  // TEST: copy the whole transcript (prose + reasoning + tool calls + per-turn meta) as Markdown.
  const [exported, setExported] = useState(false);
  const exportChat = async () => {
    const md = codeToMarkdown(messages, {
      title: chatTitle,
      harness: harness?.name ?? harnessId,
      model: model.label,
      effort: activeEffort,
      cwd,
    });
    try {
      await copyToClipboard(md);
      setExported(true);
      setTimeout(() => setExported(false), 1400);
    } catch { /* clipboard denied */ }
  };

  // Reconcile a stale codex/kimi pick against a freshly-loaded list: the hardcoded fallback
  // default may lead with a model (e.g. plan-locked gpt-5.6-sol, or a renamed kimi alias) that
  // the live list hides — reset to the live default so the selection isn't a model missing from
  // the dropdown.
  const reconcilePick = (g: CodeModelGroup[]) => {
    if ((model.kind === "codex" || model.kind === "kimi") && !g.some((grp) => grp.models.some((m) => choiceKey(m) === choiceKey(model)))) {
      setCodeConfig(chatId, { model: defaultModelForHarness(harnessId) });
    }
  };

  useEffect(() => {
    setModelGroups(peekCodeModelGroups(harnessId));
    let alive = true;
    void listCodeModelGroups(harnessId).then((g) => {
      if (!alive) return;
      setModelGroups(g);
      reconcilePick(g);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateways.length, harnessId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const toBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setAtBottom(true);
  };

  useEffect(() => {
    void refreshHarnessStatuses();
  }, []);

  // A brand-new session inherits the last-used folder, so it's ready to go on launch.
  useEffect(() => {
    if (!cwd && isEmptyCodeChat(chatId)) {
      const last = getRecentFolders()[0];
      if (last) selectFolder(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    let alive = true;
    void listBranches(cwd).then((info) => {
      if (!alive) return;
      setBranches(info.branches);
      // Restore the branch this folder was last left on (checkout may fail on a dirty tree → revert).
      const remembered = getFolderBranch(cwd);
      if (remembered && remembered !== info.current && info.branches.includes(remembered)) {
        setBranch(remembered);
        checkoutBranch(cwd, remembered).catch(() => setBranch(info.current));
      } else {
        setBranch(info.current);
      }
    });
    return () => { alive = false; };
  }, [cwd]);

  const autosize = useAutosize(taRef, 200);

  function selectFolder(dir: string) {
    setCodeConfig(chatId, { cwd: dir });
    pushRecentFolder(dir);
    setRecents(getRecentFolders());
  }

  async function pickFolder() {
    const dir = await openDialog({ directory: true, title: "Select a project folder" });
    if (typeof dir === "string") selectFolder(dir);
  }

  function pokeFolder() {
    setShowHint(true);
    requestAnimationFrame(() => {
      const el = hintRef.current;
      if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      el.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" },
         { transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "translateX(0)" }],
        { duration: 380, easing: "ease" }
      );
    });
  }

  function selectBranch(next: string) {
    if (busy || next === branch) return;
    const prev = branch;
    setBranch(next);
    setFolderBranch(cwd, next);
    checkoutBranch(cwd, next).catch(() => setBranch(prev));
  }

  // Native picks run on the CLI's own account: true when the send must wait for a login step
  // (a modal, or kimi's terminal flow). The CLI-login check is best-effort and never hard-blocks.
  async function needsLoginGate(): Promise<boolean> {
    const kind = harness?.native?.kind;
    if (!kind || model.kind !== kind) return false;
    // Kimi has no app-side OAuth — its gate rests entirely on the CLI's own credentials.
    const connected = kind === "anthropic" ? hasAnthropicOAuth() : kind === "codex" ? hasOpenAIOAuth() : false;
    if (connected || (await cliLoggedIn(harnessId))) return false;
    if (kind === "kimi") {
      // No modal for kimi — its login IS a terminal flow, so go straight there. A second send
      // with the login terminal already up means "send anyway".
      if (termOpen && termCmd === "kimi login") return false;
      setTermCmd("kimi login");
      setTermOpen(true);
      return true;
    }
    setAuthNeed(kind);
    return true;
  }

  // Stage image files (drop/paste/pick) → base64 for the model + a data URL for the chip thumbnail.
  // Non-images are ignored here (files go through pickFiles by path).
  async function addImages(list: ArrayLike<File>) {
    for (const file of Array.from(list)) {
      if (!file.type.startsWith("image/")) continue;
      const url = await readDataUrl(file).catch(() => "");
      const data = url.split(",")[1];
      if (!data) continue;
      setImages((p) => (p.some((x) => x.dataUrl === url) ? p : [...p, { name: file.name, mime: file.type, data, dataUrl: url }]));
    }
  }

  // Attach files by absolute path (Tauri dialog) — the agent's CLI reads them in place, so any type
  // or size works without copying bytes into the prompt.
  async function pickFiles() {
    const sel = await openDialog({ multiple: true, title: "Attach files" });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    setFiles((p) => {
      const next = [...p];
      for (const path of paths) if (typeof path === "string" && !next.some((f) => f.path === path)) next.push({ name: basename(path), path });
      return next;
    });
  }

  // `force` = user chose "continue anyway" in the sign-in gate.
  async function send(force = false) {
    const text = input.trim();
    if (busy) return;
    if (!cwd) { pokeFolder(); return; }
    if (!text && images.length === 0 && files.length === 0) return;
    if (!force && (await needsLoginGate())) return;
    // Attached files ride the prompt as a path list; the agent reads them with its own tools.
    const fileNote = files.length ? "\n\nAttached files (read them):\n" + files.map((f) => "- " + f.path).join("\n") : "";
    const fullText = text + fileNote;
    // Images become AI SDK `file` parts (data URL) → persisted + rendered, and extracted for the CLI
    // in resolveSend.
    const imgParts = images.map((im) => ({ type: "file" as const, mediaType: im.mime, filename: im.name, url: im.dataUrl }));
    setInput("");
    setImages([]);
    setFiles([]);
    setTimeout(() => { if (taRef.current) taRef.current.style.height = "auto"; }, 0);
    if (imgParts.length) void sendMessage({ text: fullText, files: imgParts });
    else void sendMessage({ text: fullText });
  }

  function stop() {
    void stopChat();
  }

  // Plan-mode handoff: the user approved the agent's plan — flip this chat to acceptEdits (the CLI
  // can't prompt mid-run) and resume the session so the agent executes what it just planned.
  function approvePlan() {
    if (busy) return;
    setCodeConfig(chatId, { permissionMode: "acceptEdits" });
    void sendMessage({ text: "Plan approved — proceed with the implementation." });
  }

  const folderPicker = (
    <Picker
      btnClass={"cd-folder-btn" + (cwd ? "" : " empty")}
      label={cwd ? basename(cwd) : "Select folder"}
      logo={<Icon name="folder" size={15} />}
      menuHeader="Recent"
      items={recents.map((d) => ({ id: d, label: basename(d), sub: d, check: d === cwd }))}
      footer={{ label: "Open folder…", onSelect: pickFolder }}
      onSelect={selectFolder}
    />
  );

  return (
    <div className="cd-wrap">
      {/* Once a session is under way the folder chip lives in a slim top bar with the chat title. */}
      {active && (
        <header className="cd-top" data-tauri-drag-region>
          <span className="cd-top-title" title={chatTitle}>{chatTitle}</span>
          <button className="cd-top-folder" onClick={pickFolder} title="Change project folder">
            <Icon name="folder" size={14} />
            {basename(cwd)}
          </button>
          <button className="cd-top-act" onClick={exportChat} title="Copy transcript as Markdown (test)">
            <Icon name={exported ? "check" : "copy"} size={16} />
          </button>
          <button className={"cd-top-act" + (termOpen ? " on" : "")} onClick={toggleTerm} title="Toggle terminal">
            <Icon name="terminal" size={16} />
          </button>
        </header>
      )}

      {/* Transcript */}
      <div className="cd-thread-scroll">
      <div
        className="cd-thread"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          pinnedRef.current = pinned;
          setAtBottom(pinned);
        }}
      >
        <div className="cd-thread-inner">
          {messages.length === 0 && !busy && <CodeStats />}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={m.id} className="cd-user">
                <div className="cd-user-bubble">
                  {userImages(m).length > 0 && (
                    <div className="cd-user-imgs">
                      {userImages(m).map((src, k) => (
                        <img key={k} src={src} alt="" />
                      ))}
                    </div>
                  )}
                  {userText(m) && <span className="cd-user-text">{userText(m)}</span>}
                </div>
              </div>
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                streaming={busy && i === messages.length - 1}
                onApprovePlan={!busy && i === messages.length - 1 ? approvePlan : undefined}
                chatId={chatId}
              />
            )
          )}
          {busy && (
            <div className="cd-working">
              <span className="cd-work-dot" />
              <span className="cd-work-label">Working — <ModelBadge model={model} /></span>
              {workNote && <span className="cd-work-note mono">{workNote}</span>}
            </div>
          )}
          {/* A failed turn otherwise ends silently: stream errors land on the Chat's error
              state, which nothing here rendered before — the spinner stopped and the user saw
              nothing (live-verified via the kimi no-model failure). A kimi login failure gets
              the terminal flow (auto-opened above) instead of the raw error. */}
          {!busy && status === "error" && error && (
            kimiLoginNeeded ? (
              <div className="cd-turn-error info" role="status">
                <Icon name="terminal" size={13} />
                <span>
                  Kimi sign-in required — complete <code className="mono">kimi login</code> in the
                  terminal below, then send your message again.
                </span>
              </div>
            ) : (
              <div className="cd-turn-error" role="alert">
                <Icon name="close" size={13} />
                <span>{error.message || "The agent turn failed."}</span>
              </div>
            )
          )}
        </div>
      </div>
      {!atBottom && (
        <button className="scroll-bottom-btn" onClick={toBottom} title="Scroll to bottom">
          <Icon name="chevronD" size={18} />
        </button>
      )}
      </div>

      {/* Composer */}
      <div className="cd-composer-wrap">
        <div className="cd-plate">
          {/* Workspace folder selector — enveloping plate wrapping the prompt input (new session only) */}
          {!active && <div className="cd-plate-head">{folderPicker}</div>}
          {showHint && !cwd && (
            <div className="cd-folder-hint" role="status" ref={hintRef}>
              <div className="cd-folder-hint-txt">
                <span className="cd-folder-hint-title">Choose a project folder to begin</span>
                <span className="cd-folder-hint-sub">The agent reads, runs, and edits only inside this folder.</span>
              </div>
              <span className="cd-folder-hint-arrow" />
            </div>
          )}
          <div
            className={"cd-composer" + (busy ? " busy" : "") + (dragging ? " dragover" : "")}
            onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void addImages(e.dataTransfer.files); }}
          >
          {(images.length > 0 || files.length > 0) && (
            <div className="composer-chips">
              {images.map((im, k) => (
                <div className="image-chip" key={"img" + k}>
                  <img src={im.dataUrl} alt={im.name} title={im.name} />
                  <button className="image-chip-x" onClick={() => setImages((p) => p.filter((_, j) => j !== k))} title="Remove">
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
              {files.map((f, k) => (
                <div className="paste-chip" key={"file" + k}>
                  <span className="paste-chip-body" title={f.path}>
                    <Icon name="attach" size={13} />
                    <span className="paste-chip-title">{f.name}</span>
                  </span>
                  <button className="paste-chip-x" onClick={() => setFiles((p) => p.filter((_, j) => j !== k))} title="Remove">
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
            placeholder={busy ? "Agent is working…" : cwd ? "Describe a change, a bug, or a task…" : "Select a project folder first…"}
            rows={1}
            onChange={(e) => { setInput(e.target.value); autosize(); }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (imgs.length) { e.preventDefault(); void addImages(imgs); }
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          />
          <input
            ref={imgInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.length) void addImages(e.target.files); e.target.value = ""; }}
          />
          <div className="cd-comp-bar">
            <div className="comp-add-wrap" ref={addMenuRef}>
              <button
                className={"cd-comp-tool" + (addMenuOpen ? " on" : "")}
                onClick={() => setAddMenuOpen((v) => !v)}
                title="Attach images or files"
              >
                <Icon name="plus" size={17} />
              </button>
              {addMenuOpen && (
                <div className="comp-add-menu">
                  <button className="model-menu-item" onClick={() => { setAddMenuOpen(false); imgInputRef.current?.click(); }}>
                    <span className="model-menu-logo"><Icon name="image" size={15} /></span>
                    <span style={{ flex: 1 }}>Images &amp; media</span>
                  </button>
                  <button className="model-menu-item" onClick={() => { setAddMenuOpen(false); void pickFiles(); }}>
                    <span className="model-menu-logo"><Icon name="attach" size={15} /></span>
                    <span style={{ flex: 1 }}>Files</span>
                  </button>
                </div>
              )}
            </div>
            <ModelMenu
              items={modelGroups.flatMap((g) =>
                g.models.map((c): ModelMenuItem => ({
                  key: choiceKey(c),
                  label: c.label,
                  group: g.label,
                  pid: badgePid(c),
                  modelId: c.kind === "connected" ? c.id : undefined,
                }))
              )}
              selectedKey={choiceKey(model)}
              onSelect={(key) => {
                const choice = modelGroups.flatMap((g) => g.models).find((c) => choiceKey(c) === key);
                if (choice) setCodeConfig(chatId, { model: choice });
              }}
              triggerLabel={model.label}
              triggerPid={badgePid(model)}
              triggerModelId={model.kind === "connected" ? model.id : undefined}
              footer={harness?.routable ? { label: "Add gateway…", onSelect: () => setGatewaysOpen(true) } : undefined}
              onRefresh={async () => {
                clearModelCache();
                const g = await listCodeModelGroups(harnessId);
                setModelGroups(g);
                reconcilePick(g);
              }}
            />
            <Picker
              label={harness.name}
              items={HARNESSES.map((h) => {
                const st = harnessStatuses[h.id];
                const missing = st?.installed === false;
                return {
                  id: h.id,
                  label: h.name,
                  disabled: missing,
                  sub: st?.error ?? (st?.installing ? "Installing…" : undefined),
                  subErr: !!st?.error,
                  trailing: missing ? (
                    <span
                      className="cd-pick-get"
                      role="button"
                      title={`Install ${h.name} (npm)`}
                      onClick={(e) => { e.stopPropagation(); void installHarness(h.id); }}
                    >
                      {st?.installing ? <span className="cd-pick-spin" /> : <Icon name="download" size={15} />}
                    </span>
                  ) : undefined,
                };
              })}
              onSelect={(id) => setCodeConfig(chatId, { harness: id })}
              onOpen={() => void refreshHarnessStatuses()}
            />
            <span style={{ flex: 1 }} />
            <button
              className={"cd-send" + (busy ? " stop" : (input.trim() || images.length || files.length) && cwd ? " on" : "")}
              onClick={() => (busy ? stop() : void send())}
              disabled={!busy && !(input.trim() || images.length || files.length)}
              title={busy ? "Stop" : "Send"}
            >
              {busy ? <span className="cd-send-spin" /> : <Icon name="arrowUp" size={16} />}
            </button>
          </div>
        </div>
        </div>

        {/* Controls row under the input: permission + effort left, branch + context ring right */}
        <div className="cd-underbar">
          <Picker
            label={PERMISSION_LABEL[permissionMode] ?? permissionMode}
            items={PERMISSION_MODES.map((m) => ({ id: m.id, label: m.label }))}
            onSelect={(id) => setCodeConfig(chatId, { permissionMode: id })}
          />
          {effortLevels && (
            <Picker
              label={`Effort: ${activeEffort}`}
              items={effortLevels.map((l) => ({
                // The model-default row carries id "auto" so picking it keeps tracking the default.
                id: l === effortDefault ? "auto" : l,
                label: EFFORT_LABEL[l],
                sub: l === effortDefault ? "default" : undefined,
                check: activeEffort === l,
              }))}
              onSelect={(id) => setCodeConfig(chatId, { effort: id as EffortLevel | "auto" })}
            />
          )}
          <span style={{ flex: 1 }} />
          {branches.length > 0 && (
            <Picker
              label={branch || "branch"}
              logo={<Icon name="gitBranch" size={13} />}
              items={branches.map((b) => ({ id: b, label: b, check: b === branch }))}
              onSelect={selectBranch}
            />
          )}
          <ContextRing tokens={contextTokens} limit={codeContextTokens(model)} cost={cost} modelName={model.label} providerKey={codeProviderKey(model)} modelId={model.id} />
        </div>
      </div>

      {/* Bottom terminal — real PTY, docked below the composer so the chat sits above it. */}
      {termOpen && cwd && (
        <TerminalPanel
          cwd={cwd}
          onClose={() => { setTermOpen(false); setTermCmd(null); }}
          zoom={zoom}
          bootstrapCommand={termCmd ?? undefined}
        />
      )}

      {gatewaysOpen && <GatewayModal onClose={() => setGatewaysOpen(false)} />}
      {authNeed && (
        <AuthModal
          kind={authNeed}
          harnessId={harnessId}
          harnessName={harness?.name ?? harnessId}
          onClose={() => setAuthNeed(null)}
          onDone={() => { setAuthNeed(null); void send(true); }}
        />
      )}
    </div>
  );
}

// The prompt text of a user message (its text parts joined).
function userText(m: { parts: { type: string }[] }): string {
  return (m.parts as any[])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// Data URLs of image `file` parts on a user message — rendered as thumbnails in the bubble.
function userImages(m: { parts: { type: string }[] }): string[] {
  return (m.parts as any[])
    .filter((p) => p.type === "file" && typeof p.url === "string" && String(p.mediaType ?? "").startsWith("image/"))
    .map((p) => p.url as string);
}
