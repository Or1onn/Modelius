// CodeScreen.tsx — Code mode: a real agentic coding session. The user picks an Environment
// (an agentic CLI harness like Claude Code) + a Model + a workspace folder; the Rust `agent_run`
// command drives the harness and its raw output is decoded into an AI SDK message the transcript
// renders. Streaming state lives in a module-level Chat (codeChatRegistry) so a run survives a
// chat/screen switch.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/shared/api/tauri";
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
import { choiceKey, codeContextTokens, codeProviderKey, defaultModelForHarness, type CodeModelChoice } from "@/entities/agent/model/codeModel";
import { ModelMenu, type ModelMenuItem } from "@/entities/model/ui/ModelMenu";
import { peekCodeModelGroups, listCodeModelGroups, type CodeModelGroup } from "@/entities/agent/model/codeModels";
import { clearModelCache } from "@/shared/lib/modelCache";
import { useGateways } from "@/entities/agent/model/gateways";
import { GatewayModal } from "@/pages/code/ui/GatewayModal";
import { listBranches, checkoutBranch, createWorktree } from "@/entities/agent/model/git";
import { generateBranchName } from "@/features/run-agent/lib/branchName";
import { WorktreePanel } from "@/pages/code/ui/WorktreePanel";
import { getCodeChat, getCodeConfig, getCodeTitle, setCodeConfig, subscribeCodeConfig, isEmptyCodeChat, isCodeChatLoaded, codeEffortInfo, effectiveCwd } from "@/features/run-agent/lib/codeChatRegistry";
import { fmtTokens } from "@/pages/code/model/codeUsage";
import { getTurnStatus, subscribeTurnStatus } from "@/features/run-agent/lib/turnStatus";
import { getPromptSuggestion, setPromptSuggestion, subscribePromptSuggestion } from "@/features/run-agent/lib/promptSuggestion";
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

// A staged inline attachment — an image or a PDF (base64 for the model, data URL for the chip
// thumbnail). Images extend Chat's ImageRef shape; PDFs render as a named chip instead.
interface StagedAttachment { name: string; mime: string; data: string; dataUrl: string }

// The MIME types that ride the turn inline; everything else is attached by path (pickFiles).
const INLINE_MIME = (t: string) => t.startsWith("image/") || t === "application/pdf";

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
              <div className="cd-ctx-plan-head">Plan usage limits{fetching ? " · updating…" : ""}</div>
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
  const { harness: harnessId, model, cwd, permissionMode, effort, worktreeArmed, worktreeBase, worktree } = config;
  // Where the harness actually runs — the isolated checkout once this chat has one.
  const runCwd = effectiveCwd(config);
  // Generated chat name (shares the config listener set); falls back to the first-message snippet.
  const genTitle = useSyncExternalStore(subscribe, useCallback(() => getCodeTitle(chatId), [chatId]));
  // Body restore settled — until then render neither hero nor transcript (prevents the hero
  // flashing, and its usage aggregation running, on every open of a saved chat).
  const loaded = useSyncExternalStore(subscribe, useCallback(() => isCodeChatLoaded(chatId), [chatId]));

  const [input, setInput] = useState("");
  // Staged attachments for the next turn: inline ones (images as native vision blocks, PDFs as
  // document blocks) and files (sent by absolute path — the agent reads them in place). Cleared on send.
  const [inline, setInline] = useState<StagedAttachment[]>([]);
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
  const [wtOpen, setWtOpen] = useState(false); // the worktree changes panel
  const [wtError, setWtError] = useState(""); // creation failed — shown above the composer
  const [wtBusy, setWtBusy] = useState(false); // naming + cutting the checkout, before the turn starts
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

  // Windowed transcript: mount only the newest messages; scrolling near the top (or the button)
  // reveals earlier ones from the already-loaded array. A render window only — resume ids, usage
  // and export still read the full message list. The window counts from the tail, so the chat
  // opens at its (visible) bottom exactly as before.
  const WINDOW = 20;
  const [visibleCount, setVisibleCount] = useState(WINDOW);
  const scrollAnchor = useRef<{ h: number; top: number } | null>(null); // pre-grow scroll geometry
  const showEarlier = () => {
    const el = scrollRef.current;
    if (!el || scrollAnchor.current) return; // one grow per layout pass
    scrollAnchor.current = { h: el.scrollHeight, top: el.scrollTop };
    setVisibleCount((c) => c + WINDOW);
  };
  // Older messages mount ABOVE the viewport — restore the distance to the bottom so the content
  // the user was reading doesn't jump (scroll anchoring is suppressed at scrollTop ≈ 0).
  useLayoutEffect(() => {
    const a = scrollAnchor.current;
    const el = scrollRef.current;
    if (a && el) el.scrollTop = el.scrollHeight - a.h + a.top;
    scrollAnchor.current = null;
  }, [visibleCount]);
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

  // The CLI's predicted next prompt (claude only — see promptSuggestion.ts). Offered as the
  // composer's placeholder and accepted with Tab, but only into an empty composer: overwriting
  // text the user is already typing would be worse than not suggesting at all.
  const suggestion = useSyncExternalStore(
    useCallback((cb: () => void) => subscribePromptSuggestion(chatId, cb), [chatId]),
    useCallback(() => getPromptSuggestion(chatId), [chatId])
  );
  const ghost = !busy && cwd && !input ? suggestion : "";

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
      setBranch(info.current);
      // An isolated chat works on its own branch elsewhere — never move the folder's HEAD for it.
      if (worktree) return;
      // Restore the branch this folder was last left on (checkout may fail on a dirty tree → revert).
      const remembered = getFolderBranch(cwd);
      if (remembered && remembered !== info.current && info.branches.includes(remembered)) {
        setBranch(remembered);
        checkoutBranch(cwd, remembered).catch(() => setBranch(info.current));
      }
    });
    return () => { alive = false; };
  }, [cwd, worktree]);

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

  // One control, two meanings: with isolation armed the list picks the *base* to branch from (no
  // checkout happens); otherwise it switches the folder's branch as before.
  function selectBranch(next: string) {
    if (busy || worktree) return;
    if (worktreeArmed) {
      setCodeConfig(chatId, { worktreeBase: next });
      return;
    }
    if (next === branch) return;
    const prev = branch;
    setBranch(next);
    setFolderBranch(cwd, next);
    checkoutBranch(cwd, next).catch(() => setBranch(prev));
  }

  // Arming is a pre-flight choice: the checkout is cut on the first send, and the CLI process is
  // spawned with that path — hence empty chats only.
  function toggleWorktree() {
    if (active || worktree) return;
    setWtError("");
    setCodeConfig(chatId, {
      worktreeArmed: !worktreeArmed,
      worktreeBase: worktreeArmed ? "" : worktreeBase || branch,
    });
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

  // Stage images and PDFs (drop/paste/pick) → base64 for the model + a data URL for the chip.
  // Other types are ignored here (they go through pickFiles by path).
  async function addInline(list: ArrayLike<File>) {
    for (const file of Array.from(list)) {
      if (!INLINE_MIME(file.type)) continue;
      const url = await readDataUrl(file).catch(() => "");
      const data = url.split(",")[1];
      if (!data) continue;
      setInline((p) => (p.some((x) => x.dataUrl === url) ? p : [...p, { name: file.name, mime: file.type, data, dataUrl: url }]));
    }
  }

  // Files dropped on the window arrive as paths (see the drag-drop effect). Images and PDFs are
  // read into the turn as content blocks; everything else — and anything too big or unreadable —
  // falls back to a path attachment, exactly like the Files picker.
  const addDroppedPaths = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      const file = await invoke<{ name: string; mime: string; data: string }>("attachment_read", { path }).catch(() => null);
      if (file) {
        const dataUrl = `data:${file.mime};base64,${file.data}`;
        setInline((p) => (p.some((x) => x.dataUrl === dataUrl) ? p : [...p, { name: file.name, mime: file.mime, data: file.data, dataUrl }]));
      } else {
        setFiles((p) => (p.some((f) => f.path === path) ? p : [...p, { name: basename(path), path }]));
      }
    }
  }, []);

  // Tauri owns the OS drag-drop, so on Windows the webview never sees HTML drop events — the paths
  // come through this webview event instead. `enter`/`over` drive the drop affordance; the HTML
  // handlers on the composer stay for the browser dev build, where this event never fires.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop") {
          setDragging(false);
          void addDroppedPaths(e.payload.paths);
        } else {
          setDragging(e.payload.type !== "leave");
        }
      })
      .then((un) => (gone ? un() : (stop = un)));
    return () => {
      gone = true;
      stop?.();
    };
  }, [addDroppedPaths]);

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

  // Tab (or the hint chip) fills the composer with the CLI's suggested prompt — it lands as
  // ordinary editable text, so it can be reworded before sending. Consumed once.
  function acceptSuggestion() {
    if (!ghost) return;
    setInput(ghost);
    setPromptSuggestion(chatId, "");
    taRef.current?.focus();
    setTimeout(autosize, 0); // after React paints the new value, so scrollHeight is real
  }

  // `force` = user chose "continue anyway" in the sign-in gate.
  async function send(force = false) {
    const text = input.trim();
    if (busy || wtBusy) return;
    if (!cwd) { pokeFolder(); return; }
    if (!text && inline.length === 0 && files.length === 0) return;
    if (!force && (await needsLoginGate())) return;
    // First send of an isolated chat: cut the branch and its checkout now, so the CLI process —
    // whose cwd is fixed for the life of the session — starts inside the worktree. The branch name
    // comes from a cheap model (English whatever the prompt's language); when that misses, the raw
    // prompt goes through and Rust transliterates it.
    if (worktreeArmed && !worktree) {
      setWtBusy(true);
      let created: Awaited<ReturnType<typeof createWorktree>> | null = null;
      try {
        const named = await generateBranchName(text);
        created = await createWorktree(cwd, worktreeBase, named || text || "session");
      } catch (e: unknown) {
        setWtError(e instanceof Error ? e.message : String(e));
      } finally {
        setWtBusy(false);
      }
      if (!created) return;
      setWtError("");
      setCodeConfig(chatId, { worktree: created });
    }
    // Attached files ride the prompt as a path list; the agent reads them with its own tools.
    const fileNote = files.length ? "\n\nAttached files (read them):\n" + files.map((f) => "- " + f.path).join("\n") : "";
    const fullText = text + fileNote;
    // Images/PDFs become AI SDK `file` parts (data URL) → persisted + rendered, and extracted for
    // the CLI in resolveSend.
    const imgParts = inline.map((at) => ({ type: "file" as const, mediaType: at.mime, filename: at.name, url: at.dataUrl }));
    setInput("");
    setInline([]);
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
      {/* Once a session is under way the folder chip lives in a slim top bar with the chat title.
          Before that the bar stays as a bare strip so the window is still draggable by its top edge. */}
      <header className={"cd-top" + (active ? "" : " bare")} data-tauri-drag-region>
        {active && (
          <>
            <span className="cd-top-title" title={chatTitle}>{chatTitle}</span>
            <button
              className="cd-top-folder"
              onClick={pickFolder}
              disabled={!!worktree}
              title={worktree ? "This session is bound to a worktree of this folder" : "Change project folder"}
            >
              <Icon name="folder" size={14} />
              {basename(cwd)}
            </button>
            {worktree && (
              <button className="cd-top-folder" onClick={() => setWtOpen(true)} title={worktree.path}>
                <Icon name="gitBranch" size={14} />
                {worktree.branch}
              </button>
            )}
            <button className="cd-top-act" onClick={exportChat} title="Copy transcript as Markdown (test)">
              <Icon name={exported ? "check" : "copy"} size={16} />
            </button>
            <button className={"cd-top-act" + (termOpen ? " on" : "")} onClick={toggleTerm} title="Toggle terminal">
              <Icon name="terminal" size={16} />
            </button>
          </>
        )}
      </header>

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
          if (el.scrollTop < 300 && messages.length > visibleCount) showEarlier();
        }}
      >
        <div className="cd-thread-inner">
          {messages.length === 0 && !busy && loaded && <CodeStats />}
          {messages.length > visibleCount && (
            <button className="cd-earlier" onClick={showEarlier}>
              Show {messages.length - visibleCount} earlier {messages.length - visibleCount === 1 ? "message" : "messages"}
            </button>
          )}
          {messages.slice(-visibleCount).map((m, i, shown) =>
            m.role === "user" ? (
              (m.metadata as { cliResume?: boolean } | undefined)?.cliResume ? (
                // Synthetic turn claiming a CLI-initiated continuation (background agent
                // finished while the chat was idle) — a note, not a user bubble.
                <div key={m.id} className="cd-resume-note" role="status">
                  <span className="cd-work-dot" />
                  <span>Background agent finished — session resumed</span>
                </div>
              ) : (
              <div key={m.id} className="cd-user">
                <div className="cd-user-bubble">
                  {userAttachments(m).length > 0 && (
                    <div className="cd-user-imgs">
                      {userAttachments(m).map((at, k) =>
                        at.mime.startsWith("image/") ? (
                          <img key={k} src={at.url} alt="" />
                        ) : (
                          <span className="cd-user-doc" key={k} title={at.name}>
                            <Icon name="attach" size={13} />
                            {at.name}
                          </span>
                        )
                      )}
                    </div>
                  )}
                  {userText(m) && <span className="cd-user-text">{userText(m)}</span>}
                </div>
              </div>
              )
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                streaming={busy && i === shown.length - 1}
                onApprovePlan={!busy && i === shown.length - 1 ? approvePlan : undefined}
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
        <div className={"cd-plate" + (dragging ? " dragging" : "")}>
          {dragging && (
            // Drop affordance — the whole plate is the target while a file hovers the window.
            <div className="cd-drop-veil" role="status">
              <div className="cd-drop-card">
                <span className="cd-drop-icon"><Icon name="upload" size={19} /></span>
                <span className="cd-drop-title">Drop to attach</span>
                <span className="cd-drop-sub">Images and PDFs ride the turn — other files attach by path</span>
              </div>
            </div>
          )}
          {/* Workspace folder selector — enveloping plate wrapping the prompt input (new session only) */}
          {!active && (
            <div className="cd-plate-head">
              {folderPicker}
              {/* Isolation toggle — only meaningful in a git repo, and only before the session's
                  CLI process (whose cwd is fixed) exists. */}
              {branches.length > 0 && (
                <button
                  className={"cd-wt-toggle" + (worktreeArmed ? " on" : "")}
                  onClick={toggleWorktree}
                  title="Work on a new branch in a separate checkout — your folder keeps its branch and its uncommitted work"
                >
                  <span className="cd-wt-switch" />
                  <Icon name="gitBranch" size={13} />
                  <span>Isolate in worktree</span>
                </button>
              )}
            </div>
          )}
          {wtError && (
            <div className="cd-turn-error" role="alert">
              <Icon name="close" size={13} />
              <span>{wtError}</span>
            </div>
          )}
          {wtBusy && (
            <div className="cd-wt-status" role="status">
              <span className="cd-wt-status-spin" />
              <span>Naming the branch and cutting the worktree…</span>
            </div>
          )}
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
            className={"cd-composer" + (busy ? " busy" : "")}
            onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void addInline(e.dataTransfer.files); }}
          >
          {(inline.length > 0 || files.length > 0) && (
            <div className="composer-chips">
              {inline.map((at, k) =>
                at.mime.startsWith("image/") ? (
                  <div className="image-chip" key={"img" + k}>
                    <img src={at.dataUrl} alt={at.name} title={at.name} />
                    <button className="image-chip-x" onClick={() => setInline((p) => p.filter((_, j) => j !== k))} title="Remove">
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ) : (
                  // A PDF has no thumbnail — show it as a named chip, like a path attachment.
                  <div className="paste-chip" key={"img" + k}>
                    <span className="paste-chip-body" title={at.name}>
                      <Icon name="attach" size={13} />
                      <span className="paste-chip-title">{at.name}</span>
                      <span className="paste-chip-sub">PDF</span>
                    </span>
                    <button className="paste-chip-x" onClick={() => setInline((p) => p.filter((_, j) => j !== k))} title="Remove">
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                )
              )}
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
            className={ghost ? "has-ghost" : undefined}
            value={input}
            readOnly={busy}
            placeholder={busy ? "Agent is working…" : ghost || (cwd ? "Describe a change, a bug, or a task…" : "Select a project folder first…")}
            rows={1}
            onChange={(e) => { setInput(e.target.value); autosize(); }}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files).filter((f) => INLINE_MIME(f.type));
              if (pasted.length) { e.preventDefault(); void addInline(pasted); }
            }}
            onKeyDown={(e) => {
              // Tab accepts the suggestion when there is one; otherwise it keeps moving focus.
              if (e.key === "Tab" && !e.shiftKey && ghost) { e.preventDefault(); acceptSuggestion(); return; }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
          />
          <input
            ref={imgInputRef}
            type="file"
            accept="image/*,application/pdf"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.length) void addInline(e.target.files); e.target.value = ""; }}
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
                    <span style={{ flex: 1 }}>Images &amp; PDFs</span>
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
            {ghost && (
              <button className="cd-ghost-hint" onClick={acceptSuggestion} title={ghost}>
                <span className="cd-ghost-key">Tab</span>
                <span>use suggestion</span>
              </button>
            )}
            <button
              className={"cd-send" + (busy ? " stop" : wtBusy || ((input.trim() || inline.length || files.length) && cwd) ? " on" : "")}
              onClick={() => (busy ? stop() : void send())}
              disabled={!busy && !wtBusy && !(input.trim() || inline.length || files.length)}
              title={busy ? "Stop" : wtBusy ? "Preparing the worktree…" : "Send"}
            >
              {busy || wtBusy ? <span className="cd-send-spin" /> : <Icon name="arrowUp" size={16} />}
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
          {/* Same slot, three states: the worktree's own branch (opens the changes panel), the base
              to branch from once isolation is armed, or the plain folder branch switcher. */}
          {worktree ? (
            <button className="cd-model-pick cd-wt-chip" onClick={() => setWtOpen(true)} title={worktree.path}>
              <Icon name="gitBranch" size={13} />
              <span style={{ fontWeight: 520 }}>{worktree.branch}</span>
              <span className="cd-wt-chip-sub">changes</span>
            </button>
          ) : branches.length > 0 ? (
            <Picker
              label={worktreeArmed ? `Base: ${worktreeBase || branch || "HEAD"}` : branch || "branch"}
              logo={<Icon name="gitBranch" size={13} />}
              menuHeader={worktreeArmed ? "Branch from" : undefined}
              items={branches.map((b) => ({
                id: b,
                label: b,
                check: b === (worktreeArmed ? worktreeBase || branch : branch),
              }))}
              onSelect={selectBranch}
            />
          ) : null}
          <ContextRing tokens={contextTokens} limit={codeContextTokens(model)} cost={cost} modelName={model.label} providerKey={codeProviderKey(model)} modelId={model.id} />
        </div>
      </div>

      {/* Bottom terminal — real PTY, docked below the composer so the chat sits above it. */}
      {termOpen && runCwd && (
        <TerminalPanel
          cwd={runCwd}
          onClose={() => { setTermOpen(false); setTermCmd(null); }}
          zoom={zoom}
          bootstrapCommand={termCmd ?? undefined}
        />
      )}

      {wtOpen && worktree && (
        <WorktreePanel
          worktree={worktree}
          title={chatTitle}
          busy={busy}
          onClose={() => setWtOpen(false)}
          // The checkout is gone (merged, kept as a branch, or discarded) — the chat falls back to
          // the project folder for any further turn.
          onCleared={() => setCodeConfig(chatId, { worktree: null, worktreeArmed: false })}
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

// Inline `file` parts on a user message — images render as thumbnails in the bubble, PDFs as a
// named chip (there is nothing to show for them).
function userAttachments(m: { parts: { type: string }[] }): { url: string; mime: string; name: string }[] {
  return (m.parts as any[])
    .filter((p) => p.type === "file" && typeof p.url === "string" && INLINE_MIME(String(p.mediaType ?? "")))
    .map((p) => ({ url: p.url as string, mime: String(p.mediaType ?? ""), name: typeof p.filename === "string" ? p.filename : "document.pdf" }));
}
