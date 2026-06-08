// markdown.tsx — GitHub-flavored markdown rendering + the fenced-block splitter
// shared by the chat thread (prose vs. code segments, copy-to-clipboard).
import { useState, isValidElement, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "@/shared/ui/Icon";

// Open links in the system browser instead of navigating the webview away.
export function openExternal(e: MouseEvent<HTMLAnchorElement>, href?: string) {
  if (!href) return;
  e.preventDefault();
  openUrl(href).catch(() => window.open(href, "_blank"));
}

// Flatten a markdown node tree back into its raw text (for copy-to-clipboard).
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

export type Seg = { kind: "text"; text: string } | { kind: "code"; lang: string; code: string; open: boolean };

// Split a markdown body into prose and fenced code segments, INCLUDING a trailing
// unterminated fence (open: true) so a streaming code block is one unit from the
// first token instead of leaking a few raw lines before crossing a size threshold.
export function segmentBody(text: string): Seg[] {
  const segs: Seg[] = [];
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("```", pos);
    if (open === -1) {
      segs.push({ kind: "text", text: text.slice(pos) });
      break;
    }
    if (open > pos) segs.push({ kind: "text", text: text.slice(pos, open) });
    let fenceEnd = open;
    while (text[fenceEnd] === "`") fenceEnd++;
    const fence = text.slice(open, fenceEnd); // full opener run (≥3 backticks)
    const nl = text.indexOf("\n", fenceEnd);
    if (nl === -1) {
      // Opener still streaming ("```ts" with no newline yet) — keep as text for now.
      segs.push({ kind: "text", text: text.slice(open) });
      break;
    }
    const lang = text.slice(fenceEnd, nl).trim();
    const closeMark = "\n" + fence; // length-matched close (mirrors the FENCE regex)
    const close = text.indexOf(closeMark, nl);
    if (close === -1) {
      segs.push({ kind: "code", lang, code: text.slice(nl + 1), open: true });
      break;
    }
    segs.push({ kind: "code", lang, code: text.slice(nl + 1, close), open: false });
    pos = close + closeMark.length;
  }
  return segs;
}

export const codeSegs = (text: string) =>
  segmentBody(text).filter((s): s is Extract<Seg, { kind: "code" }> => s.kind === "code");

// Fenced code block: language label (from the ```lang fence) + a copy button.
// Overrides react-markdown's `pre`. Only small/inline blocks reach here — large and
// streaming blocks are intercepted upstream by AssistantBody/UserContent as cards.
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeEl = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const className = codeEl?.props.className ?? "";
  const lang = /language-(\w+)/.exec(className)?.[1] ?? "text";
  const inner = codeEl ? codeEl.props.children : children;

  function copy() {
    navigator.clipboard?.writeText(nodeText(inner).replace(/\n$/, "")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {}
    );
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang}</span>
        <button className="code-copy" onClick={copy} title="Copy code">
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={className}>{inner}</code>
      </pre>
    </div>
  );
}

const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => openExternal(e, href)}>
      {children}
    </a>
  ),
  pre: CodeBlock,
};

// GitHub-flavored markdown rendering for assistant messages. Styling lives in
// styles.css under `.asst-body`; tolerant of the partial markdown seen mid-stream.
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}
