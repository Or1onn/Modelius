#!/usr/bin/env node
// Probe `kimi acp` (Agent Client Protocol, JSON-RPC 2.0 over JSONL stdio) — locks the wire facts
// the Modelius kimi-code harness depends on, the same way the codex app-server probe did.
// Probe-verified against: @moonshot-ai/kimi-code 0.25.0 (ACP SDK 0.23.0).
//
// No real Kimi login is needed for turn probes: a local fake OpenAI-compatible server plays the
// model provider, registered via `kimi provider add` against a local models.dev-style registry.
// KIMI_CODE_HOME is pointed at a scratch dir so the user's real config is never touched.
//
// Usage: node scripts/probeKimiAcp.mjs [p1|p2|p3|p4|p5|p6|p7|all]
// Raw captures land in the directory given by PROBE_OUT (default: ./probe-out).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT = process.env.PROBE_OUT || join(process.cwd(), "probe-out");
mkdirSync(OUT, { recursive: true });

// Node's spawn refuses .cmd/.ps1 shims without a shell (CVE-2024-27980), so on Windows run the
// npm package's JS launcher through the current node binary.
const kimiJs =
  process.platform === "win32"
    ? join(process.env.APPDATA, "npm", "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs")
    : null;
const which = kimiJs ? process.execPath : "kimi";
const baseArgs = kimiJs ? [kimiJs] : [];

// ---------- fake OpenAI chat-completions provider ----------

function sseChunks(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function textTurn(text) {
  const id = "cc_" + Math.random().toString(36).slice(2, 8);
  return [
    ...[...text].map((ch) => ({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: ch } }],
    })),
    {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    },
  ];
}

function toolCallTurn(name, args) {
  const id = "cc_" + Math.random().toString(36).slice(2, 8);
  return [
    {
      id,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    },
  ];
}

// script: array of handlers popped per POST /chat/completions.
// handler: { chunks } | { chunks: (body) => chunks } | { hang: true }
function startFakeModel(script, log) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      if (req.url.endsWith("/api.json")) {
        // models.dev-style registry for `kimi provider add`
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(registryJson(server.address().port)));
        return;
      }
      requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      log(
        `[fake-model] ${req.method} ${req.url} auth=${req.headers.authorization ?? "-"} tools=${JSON.stringify(
          (parsed?.tools ?? []).map((t) => t.function?.name ?? t.type)
        )} last_msg=${JSON.stringify((parsed?.messages ?? []).slice(-1))}`.slice(0, 800)
      );
      const step = script.shift();
      if (!step) {
        res.writeHead(500).end("script exhausted");
        return;
      }
      if (step.hang) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "cc_hang", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "…" } }] })}\n\n`);
        return; // never end
      }
      const chunks = typeof step.chunks === "function" ? step.chunks(parsed) : step.chunks;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseChunks(chunks));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

function registryJson(port) {
  return {
    probe: {
      id: "probe",
      name: "Probe Provider",
      api: `http://127.0.0.1:${port}/v1`,
      type: "openai",
      env: ["PROBE_API_KEY"],
      models: {
        "probe-model": {
          id: "probe-model",
          name: "Probe Model",
          tool_call: true,
          reasoning: false,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 128000, output: 8192 },
        },
      },
    },
  };
}

// ---------- scratch home + provider registration ----------

function newHome(name) {
  const home = join(tmpdir(), `kimi-probe-${name}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function kimiEnv(home) {
  return { ...process.env, KIMI_CODE_HOME: home, PROBE_API_KEY: "probe-token" };
}

// async: the fake registry lives in THIS process — a spawnSync here would block the event loop
// and deadlock the api.json fetch.
function registerProvider(home, port, log) {
  return new Promise((resolve) => {
    const child = spawn(which, [...baseArgs, "provider", "add", "--api-key", "probe-token", `http://127.0.0.1:${port}/api.json`], {
      env: kimiEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const t = setTimeout(() => child.kill(), 30000);
    child.on("exit", (status) => {
      clearTimeout(t);
      log(`[provider add] status=${status} stdout=${out.trim()} stderr=${err.trim()}`);
      const cfg = join(home, "config.toml");
      if (existsSync(cfg)) log(`[config.toml]\n${readFileSync(cfg, "utf8")}`);
      resolve(status === 0);
    });
  });
}

// ---------- acp process harness ----------

class Acp {
  constructor(name, home, extraArgs = []) {
    this.name = name;
    this.home = home;
    this.lines = [];
    this.nextId = 1;
    this.waiters = [];
    this.capture = join(OUT, `${name}.jsonl`);
    writeFileSync(this.capture, "");
    this.child = spawn(which, [...baseArgs, ...extraArgs, "acp"], {
      env: kimiEnv(home),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    createInterface({ input: this.child.stdout }).on("line", (l) => this.onLine(l));
    createInterface({ input: this.child.stderr }).on("line", (l) => this.log(`[stderr] ${l}`));
    this.child.on("exit", (c) => this.log(`[exit] code=${c}`));
  }

  log(s) {
    console.log(`  ${s}`);
    appendFileSync(this.capture, `# ${s}\n`);
  }

  onLine(l) {
    console.log(`  << ${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`);
    appendFileSync(this.capture, l + "\n");
    let p = null;
    try {
      p = JSON.parse(l);
    } catch {
      return;
    }
    this.lines.push(p);
    this.waiters = this.waiters.filter((w) => {
      if (w.pred(p)) {
        w.resolve(p);
        return false;
      }
      return true;
    });
  }

  send(obj) {
    const l = JSON.stringify(obj);
    console.log(`  >> ${l}`);
    appendFileSync(this.capture, `> ${l}\n`);
    this.child.stdin.write(l + "\n");
  }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return id;
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  waitFor(pred, ms, label) {
    const hit = this.lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
      this.waiters.push({
        pred,
        resolve: (p) => {
          clearTimeout(t);
          resolve(p);
        },
      });
    });
  }

  response(id, ms = 20000) {
    return this.waitFor((p) => p.id === id && p.method === undefined && (p.result !== undefined || p.error !== undefined), ms, `response #${id}`);
  }

  notification(method, ms = 20000) {
    return this.waitFor((p) => p.method === method && p.id === undefined, ms, method);
  }

  serverRequest(method, ms = 25000) {
    return this.waitFor((p) => p.method === method && p.id !== undefined, ms, `server request ${method}`);
  }

  updates(kind) {
    return this.lines.filter((l) => l.method === "session/update" && l.params?.update?.sessionUpdate === kind);
  }

  kill() {
    try {
      this.child.kill();
    } catch {}
  }
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "modelius-probe", version: "0.0.0" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- probes ----------

async function p1() {
  console.log("\n=== P1: pipelined initialize + session/new (fresh empty home — also the unauth shape) ===");
  const home = newHome("p1");
  const s = new Acp("p1", home);
  try {
    // pipelined: no await between writes (spawn_warm pattern)
    const initId = s.request("initialize", INIT_PARAMS);
    const newId = s.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const initResp = await s.response(initId);
    console.log("  P1 initialize.result:", JSON.stringify(initResp.result ?? initResp.error, null, 1));
    const newResp = await s.response(newId, 30000);
    console.log("  P1 session/new (no provider, no login):", JSON.stringify(newResp.result ?? newResp.error, null, 1));
    console.log("  P1 RESULT: pipelining", initResp.result ? "WORKS" : "FAILED");
  } finally {
    s.kill();
  }
}

async function p2() {
  console.log("\n=== P2: unauthenticated prompt error shape (empty home) ===");
  const home = newHome("p2");
  const s = new Acp("p2", home);
  try {
    const initId = s.request("initialize", INIT_PARAMS);
    await s.response(initId);
    const newId = s.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const newResp = await s.response(newId, 30000);
    console.log("  P2 session/new:", JSON.stringify(newResp.result ?? newResp.error));
    if (newResp.result?.sessionId) {
      const pid = s.request("session/prompt", {
        sessionId: newResp.result.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      const pResp = await s.response(pid, 30000);
      console.log("  P2 prompt response (unauth):", JSON.stringify(pResp.result ?? pResp.error));
    }
  } finally {
    s.kill();
  }
}

async function withProvider(name, script, extraArgs = [], { defaultModel = true } = {}) {
  const { server, port, requests } = await startFakeModel(script, console.log);
  const home = newHome(name);
  if (!(await registerProvider(home, port, console.log))) console.log("  WARNING: provider add failed");
  // ACP's auth gate only checks that a non-empty access_token is stored (classifyToken);
  // fabricate one so probes never need a real Kimi login. Turns go to the fake provider.
  mkdirSync(join(home, "credentials"), { recursive: true });
  writeFileSync(
    join(home, "credentials", "kimi-code.json"),
    JSON.stringify({ access_token: "probe-fake", refresh_token: "probe-fake", expires_at: 9999999999999, scope: "", token_type: "Bearer", expires_in: 999999 }, null, 2)
  );
  if (defaultModel) {
    // top-level key must come BEFORE any [table] section in TOML — prepend
    const cfgPath = join(home, "config.toml");
    writeFileSync(cfgPath, `default_model = "probe/probe-model"\n${readFileSync(cfgPath, "utf8")}`);
  }
  const s = new Acp(name, home, extraArgs);
  return { server, port, requests, home, s };
}

async function openSession(s) {
  const initId = s.request("initialize", INIT_PARAMS);
  const newId = s.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  await s.response(initId);
  const newResp = await s.response(newId, 30000);
  const sessionId = newResp.result?.sessionId;
  console.log("  session/new result:", JSON.stringify(newResp.result ?? newResp.error, null, 1));
  return { sessionId, newResp };
}

async function p3() {
  console.log("\n=== P3: session/new result — modes, models, set_model / set_mode ===");
  const { server, s } = await withProvider("p3", [{ chunks: textTurn("ok") }]);
  try {
    const { sessionId, newResp } = await openSession(s);
    if (!sessionId) return;
    // model surface: modes? configOptions? models field?
    console.log("  P3 modes:", JSON.stringify(newResp.result?.modes ?? null));
    console.log("  P3 models:", JSON.stringify(newResp.result?.models ?? newResp.result?.configOptions ?? null));
    // set_model probe
    const smId = s.request("session/set_model", { sessionId, modelId: "probe/probe-model" });
    const smResp = await s.response(smId, 10000).catch((e) => ({ error: String(e) }));
    console.log("  P3 session/set_model:", JSON.stringify(smResp.result ?? smResp.error));
    // set_mode probe — try a mode id from the session/new result
    const modeId = newResp.result?.modes?.availableModes?.[1]?.id ?? "yolo";
    const modId = s.request("session/set_mode", { sessionId, modeId });
    const modResp = await s.response(modId, 10000).catch((e) => ({ error: String(e) }));
    console.log(`  P3 session/set_mode(${modeId}):`, JSON.stringify(modResp.result ?? modResp.error));
  } finally {
    s.kill();
    server.close();
  }
}

async function p4() {
  console.log("\n=== P4: real turn through fake provider — session/update variants + stopReason ===");
  const { server, requests, s } = await withProvider("p4", [{ chunks: textTurn("Hello from fake model") }]);
  try {
    const { sessionId } = await openSession(s);
    if (!sessionId) return;
    const pid = s.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "say hello" }] });
    const pResp = await s.response(pid, 60000);
    console.log("  P4 prompt response:", JSON.stringify(pResp.result ?? pResp.error));
    const kinds = [...new Set(s.lines.filter((l) => l.method === "session/update").map((l) => l.params?.update?.sessionUpdate))];
    console.log("  P4 sessionUpdate kinds seen:", JSON.stringify(kinds));
    console.log("  P4 first agent_message_chunk:", JSON.stringify(s.updates("agent_message_chunk")[0]?.params));
    console.log("  P4 HTTP requests to fake model:", requests.length);
  } finally {
    s.kill();
    server.close();
  }
}

async function p5() {
  console.log("\n=== P5: permission flow — tool call needing approval ===");
  // fake model asks to run a shell command; second call wraps up after tool result
  const script = [
    { chunks: (body) => {
        const shellTool = (body?.tools ?? []).map((t) => t.function?.name).find((n) => /shell|bash|exec|cmd/i.test(n ?? ""));
        console.log("  [p5] using tool:", shellTool);
        return toolCallTurn(shellTool ?? "shell", { command: "node -e \"console.log('probe-ran')\"" });
      } },
    { chunks: textTurn("Command finished.") },
  ];
  const { server, requests, s } = await withProvider("p5", script);
  try {
    const { sessionId } = await openSession(s);
    if (!sessionId) return;
    const pid = s.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run the command" }] });
    const perm = await s.serverRequest("session/request_permission", 45000);
    console.log("  P5 permission request:", JSON.stringify(perm, null, 1));
    console.log("  P5 id typeof:", typeof perm.id);
    const allow = (perm.params?.options ?? []).find((o) => /allow/.test(o.kind ?? o.optionId ?? ""));
    s.send({ jsonrpc: "2.0", id: perm.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
    const pResp = await s.response(pid, 60000);
    console.log("  P5 prompt response:", JSON.stringify(pResp.result ?? pResp.error));
    const fedBack = JSON.stringify(requests[1]?.body?.messages ?? []).includes("probe-ran");
    console.log("  P5 RESULT: command executed (output fed back):", fedBack);
    const toolKinds = s.updates("tool_call").map((u) => u.params?.update);
    console.log("  P5 tool_call updates:", JSON.stringify(toolKinds, null, 1));
    console.log("  P5 tool_call_update sample:", JSON.stringify(s.updates("tool_call_update").slice(-1)[0]?.params?.update));
  } finally {
    s.kill();
    server.close();
  }
}

async function p6() {
  console.log("\n=== P6: session/cancel mid-turn ===");
  const { server, s } = await withProvider("p6", [{ hang: true }, { chunks: textTurn("after cancel") }]);
  try {
    const { sessionId } = await openSession(s);
    if (!sessionId) return;
    const pid = s.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hang forever" }] });
    await sleep(2500);
    s.notify("session/cancel", { sessionId });
    const pResp = await s.response(pid, 20000).catch((e) => ({ error: String(e) }));
    console.log("  P6 prompt response after cancel:", JSON.stringify(pResp.result ?? pResp.error));
    // is the session still usable?
    const pid2 = s.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "still alive?" }] });
    const p2Resp = await s.response(pid2, 30000).catch((e) => ({ error: String(e) }));
    console.log("  P6 next turn after cancel:", JSON.stringify(p2Resp.result ?? p2Resp.error));
  } finally {
    s.kill();
    server.close();
  }
}

async function p7() {
  console.log("\n=== P7: session/load across restart — history replay ===");
  const { server, s } = await withProvider("p7", [{ chunks: textTurn("first turn done") }, { chunks: textTurn("resumed") }]);
  try {
    const { sessionId } = await openSession(s);
    if (!sessionId) return;
    const pid = s.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "turn one" }] });
    await s.response(pid, 60000);
    s.kill();
    await sleep(500);
    // respawn against the same home
    const s2 = new Acp("p7b", s.home, []);
    try {
      const initId = s2.request("initialize", INIT_PARAMS);
      const resumeId = s2.request("session/resume", { sessionId, cwd: process.cwd(), mcpServers: [] });
      await s2.response(initId);
      const resumeResp = await s2.response(resumeId, 30000);
      const replayedAfterResume = s2.lines.filter((l) => l.method === "session/update" && l.params?.update?.sessionUpdate !== "available_commands_update" && l.params?.update?.sessionUpdate !== "config_option_update").length;
      console.log("  P7 session/resume:", JSON.stringify(resumeResp.result ?? resumeResp.error));
      console.log(`  P7 content updates replayed by resume (expect 0): ${replayedAfterResume}`);
      const pid2 = s2.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "turn two" }] });
      const p2Resp = await s2.response(pid2, 60000).catch((e) => ({ error: String(e) }));
      console.log("  P7 resumed turn:", JSON.stringify(p2Resp.result ?? p2Resp.error));
      JSON.stringify(s2.lines).includes("turn one") || true;
      console.log("  P7 (context check happens on the fake-model side: second request should contain turn-one history)");
    } finally {
      s2.kill();
    }
  } finally {
    s.kill();
    server.close();
  }
}

async function p8() {
  console.log("\n=== P8: root-level -m flag before `acp` — spawn-time model selection ===");
  // no default_model in config: only `-m` can select the model
  const { server, requests, s } = await withProvider("p8", [{ chunks: textTurn("via -m flag") }], ["-m", "probe/probe-model"], { defaultModel: false });
  try {
    const { sessionId, newResp } = await openSession(s);
    if (!sessionId) return;
    const current = (newResp.result?.configOptions ?? []).find((o) => o.id === "model")?.currentValue;
    console.log("  P8 currentValue with -m:", JSON.stringify(current));
    const pid = s.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "which model?" }] });
    const pResp = await s.response(pid, 60000);
    console.log("  P8 prompt response:", JSON.stringify(pResp.result ?? pResp.error));
    console.log("  P8 model actually called:", JSON.stringify(requests[0]?.body?.model ?? null), "| HTTP hits:", requests.length);
  } finally {
    s.kill();
    server.close();
  }
}

// ---------- main ----------

const what = process.argv[2] ?? "all";
const probes = { p1, p2, p3, p4, p5, p6, p7, p8 };
const run = what === "all" ? Object.values(probes) : [probes[what]];
if (run.some((f) => !f)) {
  console.error("unknown probe:", what);
  process.exit(1);
}
for (const f of run) {
  try {
    await f();
  } catch (e) {
    console.error("  PROBE FAILED:", e.message);
  }
}
process.exit(0);
