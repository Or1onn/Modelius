# Modelius

Desktop multi-provider LLM chat client. **Tauri 2** (Rust) shell + **React 19 / TypeScript**
front end (Vite 7). Connects to several providers at once, routes each request to a model
(auto by policy, or manual pick), streams the answer, and persists chats encrypted on disk.

## Features

- **Multi-provider**: Anthropic, OpenAI/Codex, OpenAI-compatible endpoints, Ollama (local), OpenRouter.
- **Auto-routing**: classifies each request and scores candidate models under a chosen policy —
  Cost, Quality, Speed, or Privacy — showing the decision and dollars saved.
- **Streaming** responses with cancellation, reasoning-trace display, and vision (image) input.
- **Encrypted persistence**: chats/artifacts stored in SQLite (`tauri-plugin-sql`), API keys in
  the OS keychain, sensitive blobs vault-encrypted. Falls back to encrypted localStorage on web.
- **Artifacts**: code blocks and attached files surfaced as cards with a version history + diff view.
- **Memory**: extracts and stores durable facts across chats.
- **Light/dark theme**, resizable/collapsible sidebar, command palette, keyboard shortcuts.
- **Auto-update** via `tauri-plugin-updater`.

## Development

```bash
npm install
npm run dev          # Vite dev server (web only, no Rust backend)
npm run tauri dev     # full desktop app — needed to exercise provider streaming,
                       # the OS keychain, and SQLite persistence
npm run build          # tsc && vite build (typecheck + production bundle)
npx tsc --noEmit        # typecheck only
```

There is no automated test suite — verify changes via `npm run tauri dev`.

## Architecture

Front end follows **Feature-Sliced Design** under `src/` (`app → pages → widgets → features →
entities → shared`, importing downward only). See `CLAUDE.md` for the full layer breakdown,
state-management approach (hand-rolled `useSyncExternalStore`, no Redux/Zustand), and
conventions (artifacts, secrets, persistence, models).

Rust backend lives in `src-tauri/src/`: `anthropic`, `openai`, `compat` (OpenAI-compatible +
Ollama), `stream` (cancellation), `artifacts` (encrypted file store), `secrets` (keychain),
`vault` (encryption).
