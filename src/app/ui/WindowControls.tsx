// WindowControls.tsx — custom caption buttons for the frameless window (min / max / close).
// The window is undecorated (see tauri.conf.json), so the app draws its own controls. Close routes
// through Tauri's onCloseRequested handler in App.tsx, which flushes the chat store before exit.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = getCurrentWindow();
    void w.isMaximized().then(setMaximized);
    let unlisten: (() => void) | undefined;
    void w.onResized(() => void w.isMaximized().then(setMaximized)).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const w = getCurrentWindow();
  return (
    <div className="win-ctl">
      <button className="win-ctl-btn" onClick={() => void w.minimize()} aria-label="Minimize" title="Minimize">
        <svg viewBox="0 0 10 10" aria-hidden><path d="M0 5h10" /></svg>
      </button>
      <button className="win-ctl-btn" onClick={() => void w.toggleMaximize()} aria-label="Maximize" title="Maximize">
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 2.5h5v5h-5z" />
            <path d="M2.5 0.5h7v7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden><path d="M0.5 0.5h9v9h-9z" /></svg>
        )}
      </button>
      <button className="win-ctl-btn close" onClick={() => void w.close()} aria-label="Close" title="Close">
        <svg viewBox="0 0 10 10" aria-hidden><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
      </button>
    </div>
  );
}
