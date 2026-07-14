// TerminalPanel.tsx — bottom terminal for Code mode. Wraps xterm.js over a real PTY (terminal_*
// Rust commands). Stays mounted once opened (toggled via the `open` prop) so a running shell /
// dev-server survives collapsing the panel; it's torn down only when CodeScreen remounts for a
// different chat. Output arrives base64-encoded over a Channel; keystrokes go back over
// terminal_write. Height is user-resizable (drag the top edge) and persisted.
import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "@/shared/ui/Icon";

type TermEvent = { type: "data"; data: string } | { type: "exit" };

const HEIGHT_KEY = "modelius.termHeight";
const H_MIN = 140;
const H_MAX = 640;
const clampH = (h: number) => Math.max(H_MIN, Math.min(h, H_MAX));

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Pull concrete colours from the live theme so the terminal matches light/dark.
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => s.getPropertyValue(n).trim() || fb;
  return {
    background: v("--code-panel", v("--panel", "#0a0a0a")),
    foreground: v("--code-text", v("--text-1", "#e6e6e6")),
    cursor: v("--accent", "#3B82F6"),
    selectionBackground: "rgba(255,255,255,0.18)",
  };
}

export function TerminalPanel({ cwd, onClose, zoom }: {
  cwd: string;
  onClose: () => void;
  zoom: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef("");
  const [height, setHeight] = useState(() => clampH(Number(localStorage.getItem(HEIGHT_KEY)) || 280));

  // Boot the terminal once per mount. A *fresh* pty id per effect run is essential: StrictMode (dev)
  // fires setup→cleanup→setup, and a shared id would let the cleanup's terminal_close race the second
  // terminal_open and kill the live shell. Unique ids make the two runs independent.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ptyId = crypto.randomUUID();
    ptyIdRef.current = ptyId;
    let disposed = false;

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

    const channel = new Channel<TermEvent>();
    channel.onmessage = (ev) => {
      if (disposed) return; // stale channel from a StrictMode-discarded run
      if (ev.type === "data") term.write(b64ToBytes(ev.data));
      else term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    };
    term.onData((d) => void invoke("terminal_write", { id: ptyId, data: d }));

    invoke("terminal_open", { id: ptyId, cwd, cols: term.cols, rows: term.rows, onEvent: channel })
      .catch((e) => { if (!disposed) term.write(`\r\n\x1b[31mterminal failed to start: ${e}\x1b[0m\r\n`); });

    // Keep the pty grid in sync with the panel size.
    const ro = new ResizeObserver(() => {
      if (!panelRef.current || panelRef.current.offsetHeight === 0) return;
      fit.fit();
      void invoke("terminal_resize", { id: ptyId, cols: term.cols, rows: term.rows });
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      void invoke("terminal_close", { id: ptyId });
      term.dispose();
    };
  }, [cwd]);

  // Drag the top edge to resize; clientY is screen px, so divide the delta back out by the shell zoom.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const onMove = (ev: MouseEvent) => setHeight(clampH(startH - (ev.clientY - startY) / zoom));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setHeight((h) => { localStorage.setItem(HEIGHT_KEY, String(h)); return h; });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div ref={panelRef} className="cd-term" style={{ height }}>
      <div className="cd-term-resize" onMouseDown={startResize} />
      <div className="cd-term-head">
        <span className="cd-term-title"><Icon name="terminal" size={13} /> Terminal</span>
        <button className="cd-term-x" onClick={onClose} title="Close terminal">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div ref={hostRef} className="cd-term-host" />
    </div>
  );
}
