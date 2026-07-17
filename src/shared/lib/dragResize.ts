// dragResize.ts — shared wiring for the drag-to-resize handles (sidebar, artifact panel):
// document-level move/up listeners, body cursor/user-select lock, and the screen-px →
// layout-px conversion (the shell's zoom scales rendered size, so deltas divide it back out).

export function dragResize(opts: {
  startX: number; // pointer x at drag start (screen px)
  startW: number; // width at drag start (layout px)
  zoom: number;
  dir: 1 | -1; // +1: width grows dragging right; -1: right-anchored panel grows dragging left
  clamp: (w: number) => number;
  onWidth: (w: number) => void;
  onDone: () => void; // release: persist the width, clear any drag-mode UI state
}): void {
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  const onMove = (ev: MouseEvent) =>
    opts.onWidth(opts.clamp(opts.startW + (opts.dir * (ev.clientX - opts.startX)) / opts.zoom));
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    opts.onDone();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// Restore a persisted width, falling back when absent/undersized.
export function restoreWidth(key: string, min: number, fallback: number, clamp?: (w: number) => number): number {
  const saved = Number(localStorage.getItem(key));
  if (!(saved >= min)) return fallback;
  return clamp ? clamp(saved) : saved;
}

export function persistWidth(key: string, w: number): void {
  localStorage.setItem(key, String(w));
}
