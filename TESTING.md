# Testing

A regression safety net so existing behavior can't silently drift.

| Layer | Runner | Location | Run |
|---|---|---|---|
| Frontend unit + integration | Vitest | `tests/unit/`, `tests/integration/` | `npm test` |
| Rust unit | cargo | inline `#[cfg(test)]` in `src-tauri/src/*.rs` | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Smoke E2E | WebDriverIO + tauri-driver | `e2e/` | `cd e2e && npm install && npm test` |

## Frontend (Vitest)

Kept outside `src/`. Config: `vitest.config.ts` (jsdom env, `@` → `src` alias mirroring
`vite.config.ts`). `npm test` runs once; `npm run test:watch` watches.

- **Unit** (`tests/unit/`) — pure logic: model routing (`route.ts`), api-id/effort mapping,
  pricing, diff, tokens, artifact hashing/parsing, chat search, version chains, error humanization.
- **Integration** (`tests/integration/`) — real store behavior in jsdom (off-Tauri, vault
  degrades to identity so no Tauri mocking): `chats.ts` index/body CRUD + `indexEntryFrom`, and
  `sessionStore.ts` driving a full routing→streaming→idle turn (streamLLM/provider/memory/title
  mocked via `vi.mock`; a manual model pick keeps the mock surface small). Uses
  `@testing-library/react`'s `renderHook`.

## Rust (cargo)

Inline `#[cfg(test)] mod tests` in each source module (compiled out of release builds). Covers the
artifact-id path-traversal guard (`valid_id`), URL join, OAuth percent-decode/query parsing, the
Node version floor, harness permission mapping + `spec`/`all`, agent argv assembly (`build_argv`),
the Claude/Codex stdout parsers (driven through a capturing `tauri::ipc::Channel`), transcript
caps, gateway translators, and the vault legacy-plaintext passthrough.

- Tests are **inline rather than in `src-tauri/tests/`** because Windows Application Control blocks
  freshly-built unsigned integration-test binaries (see gotcha below); inline tests run inside the
  lib unittest binary, which is permitted.
- The vault encrypt→decrypt roundtrip needs the OS keychain, so it's `#[ignore]`d. Run manually:
  `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored roundtrip`.

### Gotcha — `os error 4551` (Windows Application Control)

If `cargo test` fails with *"An Application Control policy has blocked this file. (os error 4551)"*,
Smart App Control / Mark-of-the-Web is blocking the freshly-built test exe. Clear it:

```powershell
Get-ChildItem src-tauri/target/debug/deps/*.exe | Unblock-File
```

Then re-run. CI (clean runners) is unaffected.

## E2E (manual)

Smoke only: the app boots and the shell (`nav.sidebar`) renders. Slow/flaky → **not** in the
pre-commit hook. See `e2e/README.md` (needs `msedgedriver` + `tauri-driver` on Windows).

## Pre-commit hook

`.githooks/pre-commit` runs typecheck + FE tests + Rust tests on every commit; any failure blocks
it. E2E is excluded. Enabled automatically via the root `prepare` npm script
(`git config core.hooksPath .githooks`), which runs on `npm install`.

## CI

`.github/workflows/ci.yml` runs on push to `main` and every PR (windows-latest): `npm ci`,
`npm run build` (typecheck + dist for tauri-build), `npm test`, then `cargo test`.
