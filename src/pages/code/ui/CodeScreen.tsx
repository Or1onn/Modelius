// CodeScreen.tsx — Code mode: a real agentic coding session. The user picks an Environment
// (an agentic CLI harness like Claude Code) + a Model + a workspace folder; the Rust `agent_run`
// command drives the harness and streams tool calls / diffs / prose into this transcript.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "@/shared/ui/Icon";
import { Markdown } from "@/shared/lib/markdown";
import { MODEL_BY_ID } from "@/entities/model/model/registry";
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
import { type Step, type DiffRow, type ToolItem } from "@/features/run-agent/lib/agentChannel";
import { CodeStats, PLogo } from "@/pages/code/ui/CodeStats";
import { getRecentFolders, pushRecentFolder } from "@/pages/code/model/recentFolders";
import {
  useCodeSession,
  sendCodeMessage,
  stopCode,
  setCodeCwd,
  setCodeHarness,
  setCodeModel,
  setCodePermissionMode,
} from "@/pages/code/model/codeSessionStore";

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// ---- lightweight HTML/JS syntax highlighter (returns React nodes) ----
function hlLine(code: string): ReactNode[] {
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(<\/?[a-zA-Z][\w-]*)|([a-zA-Z-]+)(=)|(&lt;|&gt;|[<>/])/g;
  const out: ReactNode[] = [];
  let last = 0,
    m: RegExpExecArray | null,
    k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span key={k++} className="t-str">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k++} className="t-tag">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k++} className="t-atr">{m[3]}</span>, <span key={k++} className="t-pun">{m[4]}</span>);
    else if (m[5]) out.push(<span key={k++} className="t-pun">{m[5]}</span>);
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

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
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {pid && <PLogo pid={pid} />}
      <span style={{ fontWeight: 520 }}>{model.label}</span>
    </span>
  );
}

// ---- diff rows: gutter line numbers + +/- rows (shared by the diff block and tool-row expansion) ----
function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="cd-diff-body">
      {rows.map((r, i) => (
        <div key={i} className={"cd-line " + r.t}>
          <span className="cd-ln">{r.n || ""}</span>
          <span className="cd-sign">{r.t === "add" ? "+" : r.t === "del" ? "-" : ""}</span>
          <span className="cd-code">{hlLine(r.c)}</span>
        </div>
      ))}
    </div>
  );
}

// ---- diff block: file path bar + rows ----
function DiffBlock({ path, rows }: { path: string; rows: DiffRow[] }) {
  return (
    <div className="cd-diff">
      <div className="cd-diff-path"><span className="mono">{path}</span></div>
      <DiffRows rows={rows} />
    </div>
  );
}

// Shell/command tools show their full command; file tools show just the basename.
const SHELL_VERBS = new Set(["Bash", "PowerShell", "Ran"]);

// ---- one tool-call row: header (verb + target), expands to the tool's real output ----
function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const shell = SHELL_VERBS.has(item.verb);
  const hasDiff = !!item.diff?.length;
  const expandable = hasDiff || !!item.output;
  const label = shell ? item.file : item.file ? basename(item.file) : "";
  return (
    <div className="cd-tool-row-wrap">
      <button className="cd-tool-row" onClick={() => expandable && setOpen((v) => !v)} disabled={!expandable}>
        <span className={"cd-verb " + (shell ? "ran" : "")}>{item.verb}</span>
        <span className="cd-tool-file mono">{label}</span>
        {item.add != null && <span className="cd-add mono">+{item.add}</span>}
        {item.del != null && <span className="cd-del mono">-{item.del}</span>}
        {expandable && <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>}
      </button>
      {open && (hasDiff
        ? <div className="cd-diff cd-tool-diff"><DiffRows rows={item.diff!} /></div>
        : <pre className="cd-tool-out mono">{item.output}</pre>)}
    </div>
  );
}

// Human-friendly phrasing per tool: an action verb + singular/plural noun for its count.
const VERB_PHRASE: Record<string, { verb: string; noun: [string, string] }> = {
  Read: { verb: "Read", noun: ["file", "files"] },
  Edit: { verb: "Edited", noun: ["file", "files"] },
  MultiEdit: { verb: "Edited", noun: ["file", "files"] },
  Write: { verb: "Wrote", noun: ["file", "files"] },
  Glob: { verb: "Searched", noun: ["query", "queries"] },
  Grep: { verb: "Searched", noun: ["query", "queries"] },
  Bash: { verb: "Ran", noun: ["command", "commands"] },
  PowerShell: { verb: "Ran", noun: ["command", "commands"] },
  Ran: { verb: "Ran", noun: ["command", "commands"] },
};

// Readable summary of a run, grouped by action, e.g. "Searched 1 query · Read 3 files · Edited 1 file".
function groupSummary(items: ToolItem[]): string {
  const order: string[] = [];
  const count: Record<string, number> = {};
  const meta: Record<string, { verb: string; noun: [string, string] }> = {};
  for (const it of items) {
    const m = VERB_PHRASE[it.verb] ?? { verb: it.verb, noun: ["step", "steps"] };
    const key = `${m.verb}|${m.noun[1]}`; // merge tools that read the same (Edit + MultiEdit)
    if (!(key in count)) { order.push(key); count[key] = 0; meta[key] = m; }
    count[key]++;
  }
  return order
    .map((k) => { const c = count[k], m = meta[k]; return `${m.verb} ${c} ${c === 1 ? m.noun[0] : m.noun[1]}`; })
    .join(" · ");
}

// A run of adjacent tool calls, collapsed into one tab; expand to see each action (which itself
// expands to its output/diff).
function ToolGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cd-tool">
      <button className="cd-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="cd-tool-summary">{groupSummary(items)}</span>
        <span className="cd-tool-count mono">{items.length}</span>
        <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>
      </button>
      {open && (
        <div className="cd-tool-items">
          {items.map((it, i) => <ToolRow key={it.id ?? i} item={it} />)}
        </div>
      )}
    </div>
  );
}

// Collapsible reasoning trace between steps — Code-mode twin of chat's ReasoningBlock.
// Collapsed by default: a run can emit many of these and they'd flood the transcript.
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning cd-reasoning">
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <Icon name="spark" size={12} style={{ color: "var(--accent)" }} />
        <span style={{ flex: 1, textAlign: "left" }}>Thinking</span>
        <Icon name="chevronD" size={13} style={{ transform: open ? "none" : "rotate(-90deg)", opacity: 0.6 }} />
      </button>
      {open && <div className="reasoning-body md"><Markdown text={text} /></div>}
    </div>
  );
}

function StepView({ step }: { step: Step }) {
  if (step.type === "user") return <div className="cd-user"><div className="cd-user-bubble">{step.text}</div></div>;
  if (step.type === "text") return <div className="cd-text md"><Markdown text={step.text} /></div>;
  if (step.type === "thinking") return <ThinkingBlock text={step.text} />;
  if (step.type === "toolgroup") return <ToolGroup items={step.items} />;
  if (step.type === "edit") {
    return (
      <div className="cd-editline">
        <span className="cd-edit-verb">Edited</span>
        <span className="cd-tool-file mono">{step.file}</span>
        <span className="cd-add mono">+{step.add}</span>
        <span className="cd-del mono">-{step.del}</span>
        <span className="cd-tool-caret"><Icon name="chevronD" size={13} /></span>
      </div>
    );
  }
  if (step.type === "diff") return <DiffBlock path={step.path} rows={step.rows} />;
  return null;
}

// ---- generic dropdown for the Environment / Model / Permission / folder / branch pickers ----
interface PickItem { id: string; label: string; sub?: string; check?: boolean; disabled?: boolean; subErr?: boolean; trailing?: ReactNode }
function Picker({ label, logo, items, onSelect, onOpen, down, btnClass, menuHeader, footer }: {
  label: string;
  logo?: ReactNode;
  items: PickItem[];
  onSelect: (id: string) => void;
  onOpen?: () => void; // fired on closed → open (e.g. re-probe installed CLIs)
  down?: boolean; // open downward (header) instead of upward (composer)
  btnClass?: string;
  menuHeader?: string;
  footer?: { label: string; onSelect: () => void };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
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

// Parse a registry ctx label ("200K" / "1M") into a token count for the fill ring.
function ctxLimit(label: string | undefined): number {
  if (!label) return 0;
  const m = /([\d.]+)\s*([KM])?/i.exec(label);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n);

// Context-window fill ring (Claude Code Desktop style): an arc that fills as the prompt grows.
// Click opens a popover with the context-window fill and the current model's usage.
function ContextRing({ tokens, limit, cost, modelName }: { tokens: number; limit: number; cost: number | null; modelName: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
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

export function CodeScreen({ chatId }: { chatId: string }) {
  const { steps, phase, cwd, harnessId, model, permissionMode, contextTokens, cost } = useCodeSession(chatId);
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
  // Registry entry only exists for Anthropic picks — drives the context-ring limit.
  const registryModel = model.kind === "anthropic" ? MODEL_BY_ID[model.id] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(false);
  const busy = phase === "running";

  // Revalidate async groups (Ollama daemon, connected providers); re-peek on gateway/harness change.
  useEffect(() => {
    setModelGroups(peekCodeModelGroups(harnessId));
    let alive = true;
    void listCodeModelGroups(harnessId).then((g) => { if (alive) setModelGroups(g); });
    return () => { alive = false; };
  }, [gateways.length, harnessId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps, phase]);

  // Probe which harness CLIs are installed (drives the download affordance in the picker).
  useEffect(() => {
    void refreshHarnessStatuses();
  }, []);

  // Load the workspace's git branches whenever the folder changes (empty → picker hides).
  useEffect(() => {
    let alive = true;
    void listBranches(cwd).then((info) => {
      if (!alive) return;
      setBranches(info.branches);
      setBranch(info.current);
    });
    return () => { alive = false; };
  }, [cwd]);

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function selectFolder(dir: string) {
    setCodeCwd(chatId, dir);
    pushRecentFolder(dir);
    setRecents(getRecentFolders());
  }

  async function pickFolder() {
    const dir = await openDialog({ directory: true, title: "Select a project folder" });
    if (typeof dir === "string") selectFolder(dir);
  }

  // Reveal (and shake, if already shown) the folder coach-mark when a send is attempted before a
  // folder is chosen. rAF so the animate() target exists on the first reveal.
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
    checkoutBranch(cwd, next).catch(() => setBranch(prev)); // revert on a failed checkout (e.g. dirty tree)
  }

  // Native picks run on the CLI's own account: gate the send behind sign-in when neither the
  // app's Providers login nor the CLI's credentials exist. `force` = user chose "continue anyway"
  // (detection is best-effort, never hard-block). Input stays put until the send actually goes.
  async function send(force = false) {
    const text = input.trim();
    if (busy) return;
    if (!cwd) { pokeFolder(); return; } // no workspace yet — nudge the folder coach-mark instead
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
    void sendCodeMessage(chatId, text);
  }

  function stop() {
    stopCode(chatId);
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
          {steps.length === 0 && !busy && <CodeStats />}
          {steps.map((step, i) => <StepView key={i} step={step} />)}
          {busy && (
            <div className="cd-working">
              <span className="cd-work-dot" />
              <span>Working — <ModelBadge model={model} /></span>
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
                if (choice) setCodeModel(chatId, choice);
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
              onSelect={(id) => setCodeHarness(chatId, id)}
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

        {/* Controls row under the input: permission left, branch + context ring right */}
        <div className="cd-underbar">
          <Picker
            label={PERMISSION_LABEL[permissionMode] ?? permissionMode}
            items={PERMISSION_MODES.map((m) => ({ id: m.id, label: m.label }))}
            onSelect={(id) => setCodePermissionMode(chatId, id)}
          />
          <span style={{ flex: 1 }} />
          {branches.length > 0 && (
            <Picker
              label={branch || "branch"}
              logo={<Icon name="gitBranch" size={13} />}
              items={branches.map((b) => ({ id: b, label: b, check: b === branch }))}
              onSelect={selectBranch}
            />
          )}
          <ContextRing tokens={contextTokens} limit={ctxLimit(registryModel?.ctx)} cost={cost} modelName={model.label} />
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
