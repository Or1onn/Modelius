import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The release binary is named after the Cargo package (`modelius`).
const application = path.resolve(
  __dirname,
  "..",
  "src-tauri",
  "target",
  "release",
  `modelius${os.platform() === "win32" ? ".exe" : ""}`
);

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver reads this to launch the app; browserName must be "wry" (the Tauri webview).
      // @ts-expect-error tauri-specific capability, not in the WebdriverIO type
      "tauri:options": { application },
      browserName: "wry",
    },
  ],
  // tauri-driver listens here by default.
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  reporters: ["spec"],
  logLevel: "warn",

  // Build the app (no installer bundle needed for the test) before the run.
  onPrepare: () => {
    spawnSync("npm", ["run", "tauri", "build", "--", "--no-bundle"], {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit",
      shell: true,
    });
  },
  // Start/stop the WebDriver proxy around each session. On Windows tauri-driver needs
  // msedgedriver on PATH (see README).
  beforeSession: () => {
    tauriDriver = spawn("tauri-driver", [], { stdio: [null, process.stdout, process.stderr] });
  },
  afterSession: () => {
    tauriDriver?.kill();
  },
};
