// CodeScreen.tsx — Code mode: a real agentic coding session. The user picks an Environment
// (an agentic CLI harness like Claude Code) + a Model + a workspace folder; the Rust `agent_run`
// command drives the harness and its raw output is decoded into an AI SDK message the transcript
// renders. Streaming state lives in a module-level Chat (codeChatRegistry) so a run survives a
// chat/screen switch.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "@/shared/ui/Icon";
import { ctxTokens } from "@/shared/lib/tokens";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { useAutosize } from "@/shared/lib/useAutosize";
import { MODEL_BY_ID } from "@/entities/model/model/registry";
import { anthropicEffortTier, EFFORT_LEVELS, resolveEffort, type EffortLevel } from "@/entities/model/model/apiIds";
import { HARNESSES, HARNESS_BY_ID, PERMISSION_MODES, PERMISSION_LABEL, type NativeKind } from "@/entities/agent/model/harnesses";
import { useHarnessStatuses, refreshHarnessStatuses, installHarness, cliLoggedIn } from "@/entities/agent/model/harnessStatus";
import { hasAnthropicOAuth } from "@/entities/session/model/anthropicSession";
import { hasOpenAIOAuth } from "@/entities/session/model/openaiSession";
import { AuthModal } from "@/pages/code/ui/AuthModal";
import { choiceKey, type CodeModelChoice } from "@/entities/agent/model/codeModel";
import { ModelMenu, type ModelMenuItem } from "@/entities/model/ui/ModelMenu";
import { peekCodeModelGroups, listCodeModelGroups, type CodeModelGroup } from "@/entities/agent/model/codeModels";
import { useGateways } from "@/entities/agent/model/gateways";
import { GatewayModal } from "@/pages/code/ui/GatewayModal";
import { listBranches, checkoutBranch } from "@/entities/agent/model/git";
import { getCodeChat, getCodeConfig, setCodeConfig, subscribeCodeConfig } from "@/features/run-agent/lib/codeChatRegistry";
import { getTurnStatus, subscribeTurnStatus } from "@/features/run-agent/lib/turnStatus";
import { AssistantMessage } from "@/pages/code/ui/messageParts";
import { CodeStats, PLogo } from "@/pages/code/ui/CodeStats";
import { getRecentFolders, pushRecentFolder } from "@/pages/code/model/recentFolders";

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max" };

// ---- small model badge (provider logo + name) ----
function badgePid(model: CodeModelChoice): string {
  if (model.kind === "anthropic") return "anthropic";
  if (model.kind === "codex") return "openai";
  if (model.kind === "ollama") return "ollama";
  if (model.kind === "connected") return model.providerId;
  return "";
}

function ModelBadge({ model }: { model: CodeModelChoice }) {
  const pid = badgePid(model);
  // Non-native picks run the CLI through the local gateway proxy — flag them wherever the badge
  // shows, so tool-calling quirks are traceable to the routing at a glance.
  const routed = model.kind !== "anthropic" && model.kind !== "codex";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {pid && <PLogo pid={pid} />}
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

const fmtTokens = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);

// Context-window fill ring (Claude Code Desktop style): an arc that fills as the prompt grows.
function ContextRing({ tokens, limit, cost, modelName }: { tokens: number; limit: number; cost: number | null; modelName: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, open, () => setOpen(false));
  const pct = limit > 0 ? Math.min(1, tokens / limit) : 0;
  const r = 6.5;
  const c = 2 * Math.PI * r;
  return (
    <div className="cd-ctx" ref={ref} style={{ position: "relative" }}>
      <button className="cd-ctx-btn" onClick={() => setOpen((v) => !v)} title="Context & usage">
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
          <div className="cd-ctx-pop-row" style={{ marginTop: 10 }}>
            <span>Usage</span>
            <span>{cost != null ? `$${cost.toFixed(cost < 0.01 ? 4 : 2)}` : "—"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Last assistant message's metadata carries the prompt-token count + cumulative cost.
interface RunMeta { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; totalCostUsd?: number }

export function CodeScreen({ chatId }: { chatId: string }) {
  const chat = getCodeChat(chatId);
  const { messages, status, sendMessage, stop: stopChat } = useChat({ chat, experimental_throttle: 50 });
  const subscribe = useCallback((cb: () => void) => subscribeCodeConfig(chatId, cb), [chatId]);
  const getSnapshot = useCallback(() => getCodeConfig(chatId), [chatId]);
  const config = useSyncExternalStore(subscribe, getSnapshot);
  const { harness: harnessId, model, cwd, permissionMode, effort } = config;

  const [input, setInput] = useState("");
  const [recents, setRecents] = useState<string[]>(() => getRecentFolders());
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [modelGroups, setModelGroups] = useState<CodeModelGroup[]>(() => peekCodeModelGroups(harnessId));
  const [gatewaysOpen, setGatewaysOpen] = useState(false);
  const [authNeed, setAuthNeed] = useState<NativeKind | null>(null);
  const gateways = useGateways();
  const harnessStatuses = useHarnessStatuses();
  const harness = HARNESS_BY_ID[harnessId];
  const registryModel = model.kind === "anthropic" ? MODEL_BY_ID[model.id] : undefined;
  // Effort picker only for native Anthropic picks whose model gates it (mirrors resolvedEffort in
  // the registry — other picks send no --effort flag at all).
  const effortTier = model.kind === "anthropic" ? anthropicEffortTier(model.id) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
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

  // Prompt-token fill + cost from the last assistant turn's metadata.
  const lastMeta = [...messages].reverse().find((m) => m.role === "assistant")?.metadata as RunMeta | undefined;
  const contextTokens = lastMeta
    ? (lastMeta.inputTokens ?? 0) + (lastMeta.cacheReadInputTokens ?? 0) + (lastMeta.cacheCreationInputTokens ?? 0)
    : 0;
  const cost = lastMeta?.totalCostUsd ?? null;

  useEffect(() => {
    setModelGroups(peekCodeModelGroups(harnessId));
    let alive = true;
    void listCodeModelGroups(harnessId).then((g) => { if (alive) setModelGroups(g); });
    return () => { alive = false; };
  }, [gateways.length, harnessId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  useEffect(() => {
    void refreshHarnessStatuses();
  }, []);

  useEffect(() => {
    let alive = true;
    void listBranches(cwd).then((info) => {
      if (!alive) return;
      setBranches(info.branches);
      setBranch(info.current);
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
    checkoutBranch(cwd, next).catch(() => setBranch(prev));
  }

  // Native picks run on the CLI's own account: gate the send behind sign-in when neither the app's
  // Providers login nor the CLI's credentials exist. `force` = user chose "continue anyway".
  async function send(force = false) {
    const text = input.trim();
    if (busy) return;
    if (!cwd) { pokeFolder(); return; }
    if (!text) return;
    const kind = harness?.native?.kind;
    if (!force && kind && model.kind === kind) {
      const connected = kind === "anthropic" ? hasAnthropicOAuth() : hasOpenAIOAuth();
      if (!connected && !(await cliLoggedIn(harnessId))) {
        setAuthNeed(kind);
        return;
      }
    }
    setInput("");
    setTimeout(() => { if (taRef.current) taRef.current.style.height = "auto"; }, 0);
    void sendMessage({ text });
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

  return (
    <div className="cd-wrap">
      {/* Header: workspace folder selector */}
      <header className="cd-top">
        <div className="cd-top-title">
          <Picker
            down
            btnClass={"cd-folder-btn" + (cwd ? "" : " empty")}
            label={cwd ? basename(cwd) : "Select folder"}
            logo={<Icon name="folder" size={15} />}
            menuHeader="Recent"
            items={recents.map((d) => ({ id: d, label: basename(d), sub: d, check: d === cwd }))}
            footer={{ label: "Open folder…", onSelect: pickFolder }}
            onSelect={selectFolder}
          />
        </div>
        {showHint && !cwd && (
          <div className="cd-folder-hint" role="status" ref={hintRef}>
            <span className="cd-folder-hint-arrow" />
            <div className="cd-folder-hint-txt">
              <span className="cd-folder-hint-title">Choose a project folder to begin</span>
              <span className="cd-folder-hint-sub">The agent reads, runs, and edits only inside this folder.</span>
            </div>
          </div>
        )}
      </header>

      {/* Transcript */}
      <div className="cd-thread" ref={scrollRef}>
        <div className="cd-thread-inner">
          {messages.length === 0 && !busy && <CodeStats />}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={m.id} className="cd-user"><div className="cd-user-bubble">{userText(m)}</div></div>
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
        </div>
      </div>

      {/* Composer */}
      <div className="cd-composer-wrap">
        <div className={"cd-composer" + (busy ? " busy" : "")}>
          <textarea
            ref={taRef}
            value={input}
            readOnly={busy}
            placeholder={busy ? "Agent is working…" : cwd ? "Describe a change, a bug, or a task…" : "Select a project folder first…"}
            rows={1}
            onChange={(e) => { setInput(e.target.value); autosize(); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          />
          <div className="cd-comp-bar">
            <button className="cd-comp-tool" onClick={pickFolder} title="Add files (select a project folder)">
              <Icon name="plus" size={17} />
            </button>
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
              className={"cd-send" + (busy ? " stop" : input.trim() && cwd ? " on" : "")}
              onClick={() => (busy ? stop() : void send())}
              disabled={!busy && !input.trim()}
              title={busy ? "Stop" : "Send"}
            >
              {busy ? <span className="cd-send-spin" /> : <Icon name="arrowUp" size={16} />}
            </button>
          </div>
        </div>

        {/* Controls row under the input: permission + effort left, branch + context ring right */}
        <div className="cd-underbar">
          <Picker
            label={PERMISSION_LABEL[permissionMode] ?? permissionMode}
            items={PERMISSION_MODES.map((m) => ({ id: m.id, label: m.label }))}
            onSelect={(id) => setCodeConfig(chatId, { permissionMode: id })}
          />
          {effortTier && (
            <Picker
              label={`Effort: ${effort === "auto" ? "auto" : resolveEffort(effortTier, effort)}`}
              items={[
                { id: "auto", label: "Auto", sub: `→ ${resolveEffort(effortTier, "auto")}`, check: effort === "auto" },
                ...EFFORT_LEVELS[effortTier].map((l) => ({ id: l, label: EFFORT_LABEL[l], check: effort === l })),
              ]}
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
          <ContextRing tokens={contextTokens} limit={registryModel?.ctx ? ctxTokens(registryModel.ctx) : 0} cost={cost} modelName={model.label} />
        </div>
      </div>

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
