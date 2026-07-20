// messageParts.tsx — render an AI SDK assistant message's `parts` into the Code transcript.
// Renders onto Modelius primitives (Icon, Markdown, cd-* CSS):
//  - tool calls carry a lifecycle (pending spinner → done/error);
//  - ≥3 consecutive exploration tools (Read/Grep/Glob/Web*) collapse into one "Explored N" group;
//  - when a final text answer follows the tools, the tools fold behind an "N steps" toggle and the
//    answer renders prominently.
import { useState, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { Icon } from "@/shared/ui/Icon";
import { Markdown } from "@/shared/lib/markdown";
import { diffLines } from "@/shared/lib/diff";
import { langFromPath, highlightHtml } from "@/shared/lib/highlight";
import { allowPermission, denyPermission, type PermissionRequestData } from "@/features/run-agent/lib/permission";
import { setCodeConfig } from "@/features/run-agent/lib/codeChatRegistry";
import { basename } from "@/shared/lib/paths";

export type DiffRow = { n?: number; t: "ctx" | "add" | "del"; c: string };
export type ToolItem = {
  id: string;
  verb: string;
  file: string;
  output?: string;
  diff?: DiffRow[];
  add?: number;
  del?: number;
  lang?: string;
  pending?: boolean;
  isError?: boolean;
};

const SHELL_VERBS = new Set(["Bash", "PowerShell", "Ran"]);
const EXPLORING = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

function DiffRows({ rows, lang }: { rows: DiffRow[]; lang?: string }) {
  return (
    <div className="cd-diff-body">
      {rows.map((r, i) => (
        <div key={i} className={"cd-line " + r.t}>
          <span className="cd-ln">{r.n || ""}</span>
          <span className="cd-sign">{r.t === "add" ? "+" : r.t === "del" ? "-" : ""}</span>
          <span className="cd-code hljs" dangerouslySetInnerHTML={{ __html: highlightHtml(r.c, lang) }} />
        </div>
      ))}
    </div>
  );
}

// Map a tool part → the row display model (verb, target, lifecycle, optional diff). Tools arrive as
// static `tool-<Name>` parts (name in the type) since we don't register a tool schema; `verb` is the
// resolved name.
function toToolItem(part: any, verb: string): ToolItem {
  const input = (part.input ?? {}) as any;
  const file: string = input.command ?? input.file_path ?? input.path ?? input.pattern ?? "";
  const lang = langFromPath(input.file_path ?? input.path);
  const pending = part.state === "input-streaming" || part.state === "input-available";
  const isError = part.state === "output-error";

  let output: string | undefined;
  if (isError) output = part.errorText;
  else if (part.state === "output-available") {
    const o = part.output;
    output = typeof o === "string" ? o : o == null ? undefined : JSON.stringify(o, null, 2);
    // synthetic completion marker emitted for edits/thinking — carries no real output
    if (output === '{"completed":true}') output = undefined;
  }

  let diff: DiffRow[] | undefined;
  const lower = verb.toLowerCase();
  const toRows = (old: string, next: string) =>
    diffLines(old, next).map((r) => ({ t: r.type, c: r.text, n: r.newNo ?? r.oldNo }));
  if (lower === "edit" && typeof input.old_string === "string") {
    diff = toRows(input.old_string, input.new_string ?? "");
  } else if (lower === "write" && typeof input.content === "string") {
    diff = input.content.split("\n").map((line: string, i: number) => ({ t: "add" as const, c: line, n: i + 1 }));
  } else if (lower === "multiedit" && Array.isArray(input.edits)) {
    const j = (k: string) => input.edits.map((e: any) => e?.[k] ?? "").join("\n");
    diff = toRows(j("old_string"), j("new_string"));
  }
  let add: number | undefined, del: number | undefined;
  if (diff) {
    add = diff.filter((r) => r.t === "add").length;
    del = diff.filter((r) => r.t === "del").length;
  }
  return { id: part.toolCallId, verb, file, output, diff, add, del, lang, pending, isError };
}

// ---- one tool-call row: header (verb + target + status), expands to output/diff ----
function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const shell = SHELL_VERBS.has(item.verb);
  const hasDiff = !!item.diff?.length;
  const expandable = hasDiff || !!item.output;
  const label = shell ? item.file : item.file ? basename(item.file) : "";
  return (
    <div className="cd-tool-row-wrap">
      <button className="cd-tool-row" onClick={() => expandable && setOpen((v) => !v)} disabled={!expandable}>
        <span className={"cd-verb " + (item.isError ? "err " : "") + (shell ? "ran" : "")}>{item.verb}</span>
        <span className="cd-tool-file mono">{label}</span>
        {item.add != null && <span className="cd-add mono">+{item.add}</span>}
        {item.del != null && <span className="cd-del mono">-{item.del}</span>}
        {item.pending && <span className="cd-tool-spin" />}
        {expandable && <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>}
      </button>
      {open && (hasDiff
        ? <div className="cd-diff cd-tool-diff"><DiffRows rows={item.diff!} lang={item.lang} /></div>
        : item.isError
          ? <pre className="cd-tool-out mono err">{item.output}</pre>
          : <pre className="cd-tool-out mono hljs"><code dangerouslySetInnerHTML={{ __html: highlightHtml(item.output ?? "", item.lang) }} /></pre>)}
    </div>
  );
}

// A lone tool call (not part of an exploration group) — boxed in a card so it reads as its own
// block. Without the wrapper a bare .cd-tool-row floats unstyled (no border/bg).
function SoloTool({ item }: { item: ToolItem }) {
  return <div className="cd-tool"><ToolRow item={item} /></div>;
}

const VERB_PHRASE: Record<string, { verb: string; noun: [string, string] }> = {
  Read: { verb: "Read", noun: ["file", "files"] },
  Grep: { verb: "Searched", noun: ["query", "queries"] },
  Glob: { verb: "Searched", noun: ["query", "queries"] },
  WebSearch: { verb: "Searched", noun: ["query", "queries"] },
  WebFetch: { verb: "Fetched", noun: ["page", "pages"] },
};

// Readable summary of an exploration run, e.g. "Read 3 files · Searched 1 query".
function groupSummary(items: ToolItem[]): string {
  const order: string[] = [];
  const count: Record<string, number> = {};
  const meta: Record<string, { verb: string; noun: [string, string] }> = {};
  for (const it of items) {
    const m = VERB_PHRASE[it.verb] ?? { verb: it.verb, noun: ["step", "steps"] };
    const key = `${m.verb}|${m.noun[1]}`;
    if (!(key in count)) { order.push(key); count[key] = 0; meta[key] = m; }
    count[key]++;
  }
  return order.map((k) => { const c = count[k], m = meta[k]; return `${m.verb} ${c} ${c === 1 ? m.noun[0] : m.noun[1]}`; }).join(" · ");
}

// A run of exploration tools collapsed into one tab (expand for each row).
function ExploringGroup({ items, streaming }: { items: ToolItem[]; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  return (
    <div className="cd-tool">
      <button className="cd-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="cd-tool-summary">{groupSummary(items)}</span>
        <span className="cd-tool-count mono">{items.length}</span>
        <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>
      </button>
      {open && <div className="cd-tool-items">{items.map((it) => <ToolRow key={it.id} item={it} />)}</div>}
    </div>
  );
}

// ExitPlanMode surfaced as a first-class card: the agent's plan (markdown) + an Approve action.
// `onApprove` is only passed for the newest plan of the last assistant message while idle —
// historic plans render static.
function PlanCard({ text, onApprove, onReject }: { text: string; onApprove?: () => void; onReject?: () => void }) {
  return (
    <div className="cd-plan">
      <div className="cd-plan-head">
        <Icon name="check" size={13} style={{ color: "var(--accent)" }} />
        <span>Plan</span>
      </div>
      <div className="cd-plan-body md"><Markdown text={text} /></div>
      {(onApprove || onReject) && (
        <div className="cd-plan-actions">
          {onReject && <button className="cd-plan-reject" onClick={onReject}>Keep planning</button>}
          {onApprove && <button className="cd-plan-approve" onClick={onApprove}>Approve & run</button>}
        </div>
      )}
    </div>
  );
}

// A pending can_use_tool permission prompt from the live run (stdio control protocol). Allow/Deny
// answer over agent_respond; the CLI is blocked until then. ExitPlanMode requests render as the
// plan card: approving lifts the session to acceptEdits so the agent executes in the SAME turn.
// Only rendered while the turn streams — answered/stale requests vanish from history (toNodes).
function PermissionCard({ data, chatId }: { data: PermissionRequestData; chatId?: string }) {
  const [answered, setAnswered] = useState<"allowed" | "denied" | null>(null);
  const [open, setOpen] = useState(false); // re-expand an answered (collapsed) request
  const input = data.input as Record<string, unknown>;
  if (data.toolName === "ExitPlanMode") {
    const plan = typeof input?.plan === "string" ? input.plan : "";
    return (
      <PlanCard
        text={plan}
        onApprove={answered ? undefined : () => {
          setAnswered("allowed");
          void allowPermission(data, { setMode: "acceptEdits" });
          if (chatId) setCodeConfig(chatId, { permissionMode: "acceptEdits" }); // keep the picker in sync
        }}
        onReject={answered ? undefined : () => {
          setAnswered("denied");
          void denyPermission(data, "The user rejected the plan. Stop and wait for corrections.");
        }}
      />
    );
  }
  if (data.toolName === "AskUserQuestion") return <QuestionCard data={data} />;
  const summary = String(input?.command ?? input?.file_path ?? input?.path ?? input?.url ?? "");
  // What the action does, from the tool's own self-description (Bash/PowerShell/Agent inputs carry
  // one) — the bare title ("Allow Bash?") doesn't tell the user what they're approving.
  const desc = typeof input?.description === "string" ? input.description : "";
  // Answered requests collapse to the head line (big command bodies otherwise keep eating space
  // for the rest of the turn); the head then toggles the body back open.
  const collapsed = !!answered && !open;
  return (
    <div className="cd-perm">
      <button className="cd-perm-head" disabled={!answered || !summary} onClick={() => setOpen((v) => !v)}>
        <Icon name="shield" size={13} style={{ color: "var(--accent)" }} />
        <span>Allow {data.toolName}?</span>
        {desc && <span className="cd-perm-desc" title={desc}>{desc}</span>}
        {answered && <span className="cd-perm-verdict">{answered}</span>}
        {answered && summary && <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>}
      </button>
      {summary && !collapsed && <div className="cd-perm-cmd mono">{summary}</div>}
      {!answered && (
        <div className="cd-perm-actions">
          <button className="cd-perm-btn deny" onClick={() => { setAnswered("denied"); void denyPermission(data, "User denied this action"); }}>Deny</button>
          <button className="cd-perm-btn allow" onClick={() => { setAnswered("allowed"); void allowPermission(data); }}>Allow</button>
        </div>
      )}
    </div>
  );
}

interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

// AskUserQuestion: the agent asks the user a multiple-choice question mid-turn and blocks until
// the permission answer carries `updatedInput.answers` ({question → chosen label, multiSelect
// joined with ", "}). Every question also gets an "Other…" free-text answer (CLI parity — the
// tool contract promises the user can always type a custom reply). Deny = skip the question.
function QuestionCard({ data }: { data: PermissionRequestData }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [answered, setAnswered] = useState<"allowed" | "denied" | null>(null);
  const [open, setOpen] = useState(false); // re-expand an answered (collapsed) card
  const questions = (Array.isArray((data.input as { questions?: unknown }).questions)
    ? (data.input as { questions: AgentQuestion[] }).questions
    : []
  ).filter((q) => q && typeof q.question === "string" && Array.isArray(q.options));

  // Chosen labels + the custom text (when its input is active) — the custom reply joins the
  // answer like one more label. `other` is passed explicitly where state hasn't committed yet.
  const answerOf = (q: AgentQuestion, answers: Record<string, string[]>, other: Record<string, boolean>) => {
    const labels = answers[q.question] ?? [];
    const c = other[q.question] ? (custom[q.question] ?? "").trim() : "";
    return c ? [...labels, c] : labels;
  };
  const submit = (answers: Record<string, string[]>, other: Record<string, boolean> = otherOn) => {
    setAnswered("allowed");
    const flat = Object.fromEntries(questions.map((q) => [q.question, answerOf(q, answers, other).join(", ")]));
    void allowPermission(data, { updatedInput: { ...data.input, answers: flat } });
  };
  const pick = (q: AgentQuestion, label: string) => {
    const cur = picked[q.question] ?? [];
    const next = q.multiSelect
      ? { ...picked, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      : { ...picked, [q.question]: [label] };
    // Single-select: a real option replaces an active custom answer.
    const other = q.multiSelect ? otherOn : { ...otherOn, [q.question]: false };
    setPicked(next);
    setOtherOn(other);
    // Fast path: a single single-select question answers on click, no extra Submit.
    if (questions.length === 1 && !q.multiSelect) submit(next, other);
  };
  const toggleOther = (q: AgentQuestion) => {
    const on = !otherOn[q.question];
    setOtherOn({ ...otherOn, [q.question]: on });
    if (on && !q.multiSelect) setPicked({ ...picked, [q.question]: [] });
  };
  const complete = questions.every((q) => answerOf(q, picked, otherOn).length > 0);
  // The click-to-answer fast path can't fire while a custom reply is being typed — show Answer.
  const needsSubmit = !(questions.length === 1 && !questions[0]?.multiSelect) || otherOn[questions[0]?.question ?? ""];
  const collapsed = !!answered && !open;

  return (
    <div className="cd-perm">
      <button className="cd-perm-head" disabled={!answered} onClick={() => setOpen((v) => !v)}>
        <Icon name="shield" size={13} style={{ color: "var(--accent)" }} />
        <span>The agent has a question</span>
        {collapsed && questions.length > 0 && (
          <span className="cd-perm-desc" title={questions[0].question}>
            {questions.length === 1 ? questions[0].question : `${questions.length} questions`}
          </span>
        )}
        {answered && <span className="cd-perm-verdict">{answered === "allowed" ? "answered" : "skipped"}</span>}
        {answered && <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>}
      </button>
      {!collapsed && questions.map((q) => (
        <div key={q.question} className="cd-q">
          <div className="cd-q-text">{q.question}</div>
          {q.options.map((o) => {
            const on = (picked[q.question] ?? []).includes(o.label);
            return (
              <button key={o.label} className={"cd-q-opt" + (on ? " on" : "")} disabled={!!answered} onClick={() => pick(q, o.label)}>
                <span className="cd-q-opt-label">{o.label}</span>
                {o.description && <span className="cd-q-opt-desc">{o.description}</span>}
              </button>
            );
          })}
          <button className={"cd-q-opt" + (otherOn[q.question] ? " on" : "")} disabled={!!answered} onClick={() => toggleOther(q)}>
            <span className="cd-q-opt-label">Other…</span>
            <span className="cd-q-opt-desc">Type your own answer</span>
          </button>
          {otherOn[q.question] && !answered && (
            <input
              className="cd-q-other"
              autoFocus
              placeholder="Your answer…"
              value={custom[q.question] ?? ""}
              onChange={(e) => setCustom({ ...custom, [q.question]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && complete) submit(picked); }}
            />
          )}
        </div>
      ))}
      {!answered && (
        <div className="cd-perm-actions">
          <button className="cd-perm-btn deny" onClick={() => { setAnswered("denied"); void denyPermission(data, "User skipped the question — proceed with your best judgment."); }}>Skip</button>
          {needsSubmit && (
            <button className="cd-perm-btn allow" disabled={!complete} onClick={() => submit(picked)}>Answer</button>
          )}
        </div>
      )}
    </div>
  );
}

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

function CollapsibleSteps({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="cd-steps">
      <button className="cd-steps-head" onClick={() => setOpen((v) => !v)}>
        <span style={{ flex: 1, textAlign: "left" }}>{count} {count === 1 ? "step" : "steps"}</span>
        <span className={"cd-tool-chev" + (open ? " open" : "")}><Icon name="chevronD" size={13} /></span>
      </button>
      {open && <div className="cd-steps-body">{children}</div>}
    </div>
  );
}

// ---- part → render-node classification + grouping ----
type Node =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "plan"; text: string; onApprove?: () => void }
  | { kind: "perm"; data: PermissionRequestData }
  | { kind: "tool"; item: ToolItem };

function toNodes(parts: UIMessage["parts"], streaming: boolean): Node[] {
  // Permission requests are transient run-time UI: rendered only while the turn streams (the CLI
  // is blocked on the answer), dropped from finished/persisted transcripts. A live ExitPlanMode
  // request supersedes its own tool part — the PermissionCard renders the plan with the actions.
  const livePlanIds = new Set<string>();
  if (streaming) {
    for (const p of parts as any[]) {
      if (p.type === "data-permission" && p.data?.toolName === "ExitPlanMode" && p.data?.toolUseId)
        livePlanIds.add(p.data.toolUseId);
    }
  }

  const nodes: Node[] = [];
  for (const p of parts as any[]) {
    if (p.type === "text" && p.text?.trim()) nodes.push({ kind: "text", text: p.text });
    else if (p.type === "reasoning" && p.text?.trim()) nodes.push({ kind: "thinking", text: p.text });
    else if (p.type === "data-permission" && p.data) {
      if (streaming) nodes.push({ kind: "perm", data: p.data as PermissionRequestData });
    }
    // Tools are static `tool-<Name>` parts (or `dynamic-tool` if ever flagged); name lives in the type.
    else if (p.type === "dynamic-tool" || (typeof p.type === "string" && p.type.startsWith("tool-"))) {
      const name: string = p.type === "dynamic-tool" ? p.toolName : p.type.slice("tool-".length);
      if (name === "Thinking") {
        const t = p.input?.text;
        if (typeof t === "string" && t.trim()) nodes.push({ kind: "thinking", text: t });
      } else if (name === "ExitPlanMode" && typeof p.input?.plan === "string") {
        // The plan-mode handoff: render the plan itself as a card (while the input is still
        // streaming it stays a generic tool row and upgrades once `plan` is complete).
        if (!livePlanIds.has(p.toolCallId)) nodes.push({ kind: "plan", text: p.input.plan });
      } else {
        nodes.push({ kind: "tool", item: toToolItem(p, name) });
      }
    }
  }
  return nodes;
}

// Render a run of nodes: consecutive exploration tools (≥3) collapse into one ExploringGroup;
// everything else renders inline in order.
function renderNodes(nodes: Node[], streaming: boolean, keyBase: string, chatId?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let run: ToolItem[] = [];
  const flush = (atEnd: boolean) => {
    if (!run.length) return;
    if (run.length >= 3) out.push(<ExploringGroup key={`${keyBase}-g${out.length}`} items={run} streaming={streaming && atEnd} />);
    else run.forEach((it) => out.push(<SoloTool key={it.id} item={it} />));
    run = [];
  };
  nodes.forEach((n, i) => {
    if (n.kind === "tool" && EXPLORING.has(n.item.verb)) { run.push(n.item); return; }
    flush(false);
    if (n.kind === "tool") out.push(<SoloTool key={n.item.id} item={n.item} />);
    else if (n.kind === "thinking") out.push(<ThinkingBlock key={`${keyBase}-th${i}`} text={n.text} />);
    else if (n.kind === "plan") out.push(<PlanCard key={`${keyBase}-pl${i}`} text={n.text} onApprove={n.onApprove} />);
    else if (n.kind === "perm") out.push(<PermissionCard key={n.data.requestId} data={n.data} chatId={chatId} />);
    else out.push(<div key={`${keyBase}-tx${i}`} className="cd-text md"><Markdown text={n.text} /></div>);
  });
  flush(true);
  return out;
}

export function AssistantMessage({ message, streaming, onApprovePlan, chatId }: { message: UIMessage; streaming: boolean; onApprovePlan?: () => void; chatId?: string }) {
  const nodes = toNodes(message.parts, streaming);
  if (!nodes.length) return null;

  // Collapse-before-final: when a text answer follows the last tool (and we're done streaming),
  // fold the preceding steps behind an "N steps" toggle and show the answer prominently.
  let lastTool = -1, lastText = -1, lastPlan = -1;
  nodes.forEach((n, i) => { if (n.kind === "tool") lastTool = i; if (n.kind === "text") lastText = i; if (n.kind === "plan") lastPlan = i; });

  // The Approve action goes to the newest plan only (the screen passes onApprovePlan just for the
  // last assistant message while idle).
  if (lastPlan !== -1 && onApprovePlan) (nodes[lastPlan] as Node & { kind: "plan" }).onApprove = onApprovePlan;

  const collapse = !streaming && lastTool !== -1 && lastText > lastTool;

  if (!collapse) return <>{renderNodes(nodes, streaming, message.id, chatId)}</>;
  // Never fold a trailing plan into the "N steps" toggle — the plan is the turn's outcome.
  const cut = lastPlan > lastTool ? Math.min(lastText, lastPlan) : lastText;
  const steps = nodes.slice(0, cut);
  const final = nodes.slice(cut);
  return (
    <>
      <CollapsibleSteps count={steps.length}>{renderNodes(steps, false, `${message.id}-s`)}</CollapsibleSteps>
      {renderNodes(final, false, `${message.id}-f`)}
    </>
  );
}
