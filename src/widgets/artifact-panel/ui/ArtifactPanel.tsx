// ArtifactPanel.tsx — right-side viewer for a code artifact opened from the chat.
import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js";
import { Icon } from "@/shared/ui/Icon";
import { formatBytes, type Artifact } from "@/entities/artifact/model/artifacts";
import { diffLines } from "@/shared/lib/diff";
import { getZoom } from "@/entities/settings/model/settings";

// Canonical artifact lang id → highlight.js name (only where it differs from an hljs alias).
const HLJS_LANG: Record<string, string> = {
  tsx: "typescript", jsx: "javascript", rs: "rust", kt: "kotlin", rb: "ruby", md: "markdown", html: "xml",
};

// Highlighted HTML for the code view, or null when the language isn't registered (render plain).
function highlightCode(code: string, lang: string): string | null {
  const name = HLJS_LANG[lang] ?? lang;
  if (name && hljs.getLanguage(name)) return hljs.highlight(code, { language: name }).value;
  return null;
}

// Persisted panel width (px). Clamped to [MIN_WIDTH, avail-MIN_REST] so the chat stays usable.
const WIDTH_KEY = "orchestro.artifactPanelWidth";
const MIN_WIDTH = 320;
const MIN_REST = 420; // min space left for the chat column
// `avail` = width of the panel's container (chat area, excludes the sidebar).
const clampWidth = (w: number, avail: number) => Math.max(MIN_WIDTH, Math.min(w, avail - MIN_REST));

export function ArtifactPanel({
  artifact,
  onClose,
  generating,
  versions = [],
  versionIndex = -1,
}: {
  artifact: Artifact;
  onClose: () => void;
  generating?: boolean;
  versions?: Artifact[]; // version chain for this file (by title), in thread order
  versionIndex?: number; // index of `artifact` within `versions` (-1 if not part of a chain)
}) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"code" | "diff">("code");
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved >= MIN_WIDTH ? saved : 420;
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const pinnedRef = useRef(true); // following the stream; scrolling up unpins

  // Re-clamp a restored/oversized width against the current container (e.g. smaller window).
  useEffect(() => {
    const avail = asideRef.current?.parentElement?.clientWidth;
    if (avail) setWidth((w) => clampWidth(w, avail));
  }, []);

  // Drag the left edge to resize. Width is measured from the panel's fixed right edge,
  // so it's independent of how the rest of the layout is anchored.
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    // Container = chat area (panel's parent); its width caps how wide the panel may grow.
    const avail = (e.currentTarget.parentElement?.parentElement?.clientWidth ?? window.innerWidth);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    // clientX is screen px; the shell's zoom scales rendered size, so divide the delta back out.
    const z = getZoom();
    const onMove = (ev: MouseEvent) => setWidth(clampWidth(startW + (startX - ev.clientX) / z, avail));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const hasPrev = versionIndex > 0;
  const diffAvailable = hasPrev && !generating;
  // Fall back to code view when diff isn't available (first version, streaming, or chip preview).
  const showDiff = view === "diff" && diffAvailable;
  const rows = useMemo(
    () => (showDiff ? diffLines(versions[versionIndex - 1].code, artifact.code) : []),
    [showDiff, versions, versionIndex, artifact.code]
  );
  const highlighted = useMemo(() => highlightCode(artifact.code, artifact.lang), [artifact.code, artifact.lang]);
  const gutter = useMemo(
    () => Array.from({ length: artifact.code.split("\n").length }, (_, i) => i + 1).join("\n"),
    [artifact.code]
  );

  // Keep newest code in view while generating, but only if still pinned (don't yank back).
  useEffect(() => {
    const el = bodyRef.current;
    if (generating && el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [artifact.code, generating]);

  function copy() {
    navigator.clipboard?.writeText(artifact.code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {}
    );
  }

  return (
    <aside ref={asideRef} className="routing-panel artifact-panel" style={{ width }}>
      <div className="ap-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="rp-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Icon name="code" size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span className="ap-title">{artifact.title}</span>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close artifact">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="ap-meta">
        {generating ? (
          <span className="ap-gen">
            <span className="ac-pulse" />
            Generating…
          </span>
        ) : (
          <span className="ap-lang">{artifact.lang || "text"}</span>
        )}
        <span>·</span>
        <span>{formatBytes(artifact.bytes)}</span>
        <span>·</span>
        <span>{artifact.lines} lines</span>
        {versions.length > 1 && versionIndex >= 0 && (
          <span className="ap-ver" title="Version in this chat">
            v{versionIndex + 1} / {versions.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {diffAvailable && (
          <div className="ap-view-toggle">
            <button className={view === "code" ? "on" : ""} onClick={() => setView("code")}>
              Code
            </button>
            <button className={view === "diff" ? "on" : ""} onClick={() => setView("diff")} title="Changes vs previous version">
              Diff
            </button>
          </div>
        )}
        <button className="ap-copy" onClick={copy} title="Copy code">
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        className="ap-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {showDiff ? (
          <div className="ap-diff">
            {rows.map((r, k) => (
              <div className={"diff-line " + r.type} key={k}>
                <span className="diff-gutter">{r.oldNo ?? ""}</span>
                <span className="diff-gutter">{r.newNo ?? ""}</span>
                <span className="diff-sign">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
                <span className="diff-text">{r.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <pre className="ap-code">
            <span className="ap-gutter" aria-hidden="true">{gutter}</span>
            {highlighted ? (
              <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <code>{artifact.code}</code>
            )}
          </pre>
        )}
      </div>
    </aside>
  );
}
