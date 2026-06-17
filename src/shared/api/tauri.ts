// tauri.ts — running inside the Tauri shell? (falsy in plain browser → callers use localStorage)
export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
