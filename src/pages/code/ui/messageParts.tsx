// messageParts.tsx — render an AI SDK assistant message's `parts` into the Code transcript.
// Ports the 1code render ideas onto Modelius primitives (Icon, Markdown, cd-* CSS):
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

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
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
export function toToolItem(part: any, verb: string): ToolItem {
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
  | { kind: "tool"; item: ToolItem };

function toNodes(parts: UIMessage["parts"]): Node[] {
  const nodes: Node[] = [];
  for (const p of parts as any[]) {
    if (p.type === "text" && p.text?.trim()) nodes.push({ kind: "text", text: p.text });
    else if (p.type === "reasoning" && p.text?.trim()) nodes.push({ kind: "thinking", text: p.text });
    // Tools are static `tool-<Name>` parts (or `dynamic-tool` if ever flagged); name lives in the type.
    else if (p.type === "dynamic-tool" || (typeof p.type === "string" && p.type.startsWith("tool-"))) {
      const name: string = p.type === "dynamic-tool" ? p.toolName : p.type.slice("tool-".length);
      if (name === "Thinking") {
        const t = p.input?.text;
        if (typeof t === "string" && t.trim()) nodes.push({ kind: "thinking", text: t });
      } else {
        nodes.push({ kind: "tool", item: toToolItem(p, name) });
      }
    }
  }
  return nodes;
}

// Render a run of nodes: consecutive exploration tools (≥3) collapse into one ExploringGroup;
// everything else renders inline in order.
function renderNodes(nodes: Node[], streaming: boolean, keyBase: string): ReactNode[] {
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
    else out.push(<div key={`${keyBase}-tx${i}`} className="cd-text md"><Markdown text={n.text} /></div>);
  });
  flush(true);
  return out;
}

export function AssistantMessage({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  const nodes = toNodes(message.parts);
  if (!nodes.length) return null;

  // Collapse-before-final: when a text answer follows the last tool (and we're done streaming),
  // fold the preceding steps behind an "N steps" toggle and show the answer prominently.
  let lastTool = -1, lastText = -1;
  nodes.forEach((n, i) => { if (n.kind === "tool") lastTool = i; if (n.kind === "text") lastText = i; });
  const collapse = !streaming && lastTool !== -1 && lastText > lastTool;

  if (!collapse) return <>{renderNodes(nodes, streaming, message.id)}</>;
  const steps = nodes.slice(0, lastText);
  const final = nodes.slice(lastText);
  return (
    <>
      <CollapsibleSteps count={steps.length}>{renderNodes(steps, false, `${message.id}-s`)}</CollapsibleSteps>
      {renderNodes(final, false, `${message.id}-f`)}
    </>
  );
}
