// CodeScreen.tsx — Code mode: a real agentic coding session. The user picks an Environment
// (an agentic CLI harness like Claude Code) + a Model + a workspace folder; the Rust `agent_run`
// command drives the harness and streams tool calls / diffs / prose into this transcript.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "@/shared/ui/Icon";
import { Markdown } from "@/shared/lib/markdown";
import { ProviderLogo } from "@/entities/model/ui/ProviderLogo";
import { PROVIDERS, MODEL_BY_ID } from "@/entities/model/model/registry";
import { HARNESSES, HARNESS_BY_ID, PERMISSION_MODES, PERMISSION_LABEL } from "@/entities/agent/model/harnesses";
import { type Step, type DiffRow, type ToolItem } from "@/features/run-agent/lib/agentChannel";
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
function ModelBadge({ modelId }: { modelId: string }) {
  const m = MODEL_BY_ID[modelId];
  if (!m) return <span>{modelId}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="model-pick-logo" style={{ color: PROVIDERS[m.provider]?.color }}>
        <ProviderLogo pid={m.provider} short={PROVIDERS[m.provider]?.short ?? "?"} />
      </span>
      <span style={{ fontWeight: 520 }}>{m.name}</span>
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

function StepView({ step }: { step: Step }) {
  if (step.type === "user") return <div className="cd-user"><div className="cd-user-bubble">{step.text}</div></div>;
  if (step.type === "text") return <div className="cd-text md"><Markdown text={step.text} /></div>;
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

// ---- generic upward dropdown for the Environment / Model pickers ----
function Picker({ label, logo, items, onSelect }: {
  label: string;
  logo?: ReactNode;
  items: { id: string; label: string }[];
  onSelect: (id: string) => void;
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
      <button className="cd-model-pick" onClick={() => setOpen((v) => !v)} title={label}>
        {logo}
        <span style={{ fontWeight: 520 }}>{label}</span>
        <Icon name="chevron" size={10} style={{ transform: "rotate(-90deg)", opacity: 0.6 }} />
      </button>
      {open && (
        <div className="cd-pick-menu">
          {items.map((it) => (
            <button key={it.id} className="cd-pick-item" onClick={() => { onSelect(it.id); setOpen(false); }}>
              {it.label}
            </button>
          ))}
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
  const { steps, phase, cwd, harnessId, modelId, permissionMode, contextTokens, cost } = useCodeSession(chatId);
  const [input, setInput] = useState("");
  const harness = HARNESS_BY_ID[harnessId];
  const models = harness.models();
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase === "running";

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps, phase]);

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  async function pickFolder() {
    const dir = await openDialog({ directory: true, title: "Select a project folder" });
    if (typeof dir === "string") setCodeCwd(chatId, dir);
  }

  function send() {
    const text = input.trim();
    if (!text || busy || !cwd) return;
    setInput("");
    setTimeout(() => { if (taRef.current) taRef.current.style.height = "auto"; }, 0);
    void sendCodeMessage(chatId, text);
  }

  function stop() {
    stopCode(chatId);
  }

  return (
    <div className="cd-wrap">
      {/* Header: workspace folder + harness tag */}
      <header className="cd-top">
        <div className="cd-top-title">
          <span className="cd-title-text">{cwd ? basename(cwd) : "Code mode"}</span>
        </div>
      </header>

      {/* Transcript */}
      <div className="cd-thread" ref={scrollRef}>
        <div className="cd-thread-inner">
          {steps.length === 0 && !busy && (
            <p className="cd-text" style={{ color: "var(--text-4)" }}>
              {cwd ? "Describe a change, a bug, or a task — the agent will work in your project folder." : "Select a project folder to begin."}
            </p>
          )}
          {steps.map((step, i) => <StepView key={i} step={step} />)}
          {busy && (
            <div className="cd-working">
              <span className="cd-work-dot" />
              <span>Working — <ModelBadge modelId={modelId} /></span>
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
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div className="cd-comp-bar">
            <button className="cd-comp-tool" onClick={pickFolder} title="Add files (select a project folder)">
              <Icon name="plus" size={17} />
            </button>
            <Picker
              label={harness.name}
              logo={<Icon name="terminal" size={13} />}
              items={HARNESSES.map((h) => ({ id: h.id, label: h.name }))}
              onSelect={(id) => setCodeHarness(chatId, id)}
            />
            <Picker
              label={MODEL_BY_ID[modelId]?.name ?? modelId ?? "Model"}
              logo={modelId ? <span className="model-pick-logo" style={{ color: PROVIDERS[MODEL_BY_ID[modelId]?.provider]?.color }}><ProviderLogo pid={MODEL_BY_ID[modelId]?.provider ?? ""} short={PROVIDERS[MODEL_BY_ID[modelId]?.provider]?.short ?? "?"} /></span> : undefined}
              items={models.map((m) => ({ id: m.id, label: m.name }))}
              onSelect={(id) => setCodeModel(chatId, id)}
            />
            <span style={{ flex: 1 }} />
            <button
              className={"cd-send" + (busy ? " stop" : input.trim() && cwd ? " on" : "")}
              onClick={busy ? stop : send}
              disabled={!busy && (!input.trim() || !cwd)}
              title={busy ? "Stop" : "Send"}
            >
              {busy ? <span className="cd-send-spin" /> : <Icon name="send" size={15} />}
            </button>
          </div>
        </div>

        {/* Controls row under the input: permission + branch left, context ring far right */}
        <div className="cd-underbar">
          <Picker
            label={PERMISSION_LABEL[permissionMode] ?? permissionMode}
            logo={<Icon name="shield" size={13} />}
            items={PERMISSION_MODES.map((m) => ({ id: m.id, label: m.label }))}
            onSelect={(id) => setCodePermissionMode(chatId, id)}
          />
          <button className="cd-proj" onClick={pickFolder} title={cwd || "Select a project folder"}>
            <Icon name="gitBranch" size={12} />{cwd ? basename(cwd) : "Select folder"}
          </button>
          <span style={{ flex: 1 }} />
          <ContextRing tokens={contextTokens} limit={ctxLimit(MODEL_BY_ID[modelId]?.ctx)} cost={cost} modelName={MODEL_BY_ID[modelId]?.name ?? modelId ?? "Model"} />
        </div>
      </div>
    </div>
  );
}
