// useOutsideClick.ts — close-on-outside-click for popovers/menus: while `open`, a mousedown
// outside `ref` calls `onClose`. The callback is kept in a ref so the handler always sees the
// latest closure (e.g. a draft being edited) without re-registering the listener per render.
import { useEffect, useRef, type RefObject } from "react";

export function useOutsideClick(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, ref]);
}
