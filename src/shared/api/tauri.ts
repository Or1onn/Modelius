// tauri.ts — single source of truth for "are we running inside the Tauri shell?".
// Falsy in a plain browser (npm run dev), where callers fall back to localStorage.
export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
