// ArtifactPanel.tsx — right-side viewer for a code artifact opened from the chat.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { formatBytes, type Artifact } from "@/entities/artifact/model/artifacts";

export function ArtifactPanel({ artifact, onClose, generating }: { artifact: Artifact; onClose: () => void; generating?: boolean }) {
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // following the stream; scrolling up to read unpins

  // Follow the stream: keep the newest code in view while it's still generating —
  // but only while the user is still at the bottom (don't yank them back if they scrolled up).
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
    <aside className="routing-panel artifact-panel">
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
        <span style={{ flex: 1 }} />
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
        <pre>
          <code>{artifact.code}</code>
        </pre>
      </div>
    </aside>
  );
}
