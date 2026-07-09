# E2E smoke tests

WebDriverIO + [`tauri-driver`](https://tauri.app/develop/tests/webdriver/) driving the real
desktop build. **Slow and not part of the pre-commit hook** — run on demand.

Currently one smoke spec: the app boots and the shell (`nav.sidebar`) renders.

## Prerequisites (Windows)

1. **Microsoft Edge WebDriver** (`msedgedriver.exe`) on `PATH`, matching your installed Edge
   version — download from <https://developer.microsoft.com/microsoft-edge/tools/webdriver/>.
   Tauri's webview is WebView2 (Edge), so this is the driver `tauri-driver` proxies to.
2. **`tauri-driver`** installed and on `PATH`: `cargo install tauri-driver`.
3. A Rust + Node toolchain (same as building the app).

## Run

```sh
cd e2e
npm install          # installs wdio + tsx here only, not in the root project
npm test             # builds the release app (--no-bundle) then runs the smoke spec
```

`wdio.conf.ts` builds the app, launches `tauri-driver`, and points it at
`../src-tauri/target/release/modelius.exe`.

## Notes

- macOS is not supported by `tauri-driver` (no WKWebView WebDriver); Linux uses
  `WebKitWebDriver`. This scaffold targets Windows.
- Add specs under `specs/*.e2e.ts`. Keep them resilient — assert durable structure, not copy.
