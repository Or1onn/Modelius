import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Standalone test config — does NOT import the app vite.config.ts (that one is an async
// config wired for Tauri dev). Only the `@` → src alias is shared, kept in sync by hand
// with vite.config.ts and tsconfig.json:paths.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // jsdom so the few modules that touch localStorage/window import cleanly; the targets
    // themselves are pure functions.
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
