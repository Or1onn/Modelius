// useAutosize.ts — returns a callback that grows a textarea with its content up to `max` px
// (then it scrolls). Call it from onChange and anywhere the content is set programmatically.
import { useCallback, type RefObject } from "react";

export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, max: number): () => void {
  return useCallback(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  }, [ref, max]);
}
