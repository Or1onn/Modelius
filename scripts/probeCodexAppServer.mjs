#!/usr/bin/env node
// Probe `codex app-server` (v2 thread/turn JSON-RPC over JSONL) — locks the wire facts the
// Modelius codex harness depends on, the same way the claude 2.1.206 stdio probe did.
// Probe-verified against: codex-cli 0.142.5.
//
// No real ChatGPT auth is needed: a local fake Responses-API server plays the model provider
// (codex is pointed at it with the same `-c model_providers.modelius.*` overrides the app's
// routed runs use). That also makes P4 (HTTP vs websocket) self-evident: if the fake server
// receives a plain HTTP POST /v1/responses, custom providers use HTTP.
//
// Usage: node scripts/probeCodexAppServer.mjs [p1|p2|p3|p4|p5|p7|all]
// Raw captures land in the directory given by PROBE_OUT (default: ./probe-out).

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT = process.env.PROBE_OUT || join(process.cwd(), "probe-out");
mkdirSync(OUT, { recursive: true });

// Node's spawn refuses .cmd shims without a shell (CVE-2024-27980), so on Windows run the npm
// package's JS launcher through the current node binary.
const codexJs =
  process.platform === "win32"
    ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : null;
const which = codexJs ? process.execPath : "codex";
const baseArgs = codexJs ? [codexJs] : [];

// ---------- fake Responses API ----------

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function textTurn(text) {
  const id = "msg_" + Math.random().toString(36).slice(2, 8);
  return [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id, content: [] } },
    // deltas: verify app-server relays them as item/agentMessage/delta notifications
    ...[...text].map((ch, i) => ({
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: ch,
      ...(i === 0 ? {} : {}),
    })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 17,
        },
      },
    },
  ];
}

function shellCallTurn(command, toolName, extra = {}) {
  const args = JSON.stringify({ command, ...extra });
  return [
    { type: "response.created", response: { id: "resp_fc" } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: toolName, arguments: args },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_fc",
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 28,
        },
      },
    },
  ];
}

// script: array of handlers; each POST /v1/responses pops the next one.
// handler: { events } | { events: (body) => events } | { hang: true }
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
      requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      log(
        `[fake-model] ${req.method} ${req.url} auth=${req.headers.authorization ?? "-"} tools=${JSON.stringify(
          (parsed?.tools ?? []).map((t) => t.name ?? t.type)
        )} input_tail=${JSON.stringify((parsed?.input ?? []).slice(-2))}`
      );
      if (process.env.PROBE_DUMP_TOOLS) {
        const shellTool = (parsed?.tools ?? []).find((t) => /shell|exec/i.test(t.name ?? ""));
        log(`[fake-model] shell tool def: ${JSON.stringify(shellTool)}`);
      }
      const step = script.shift();
      if (!step) {
        res.writeHead(500).end("script exhausted");
        return;
      }
      if (step.hang) {
        // hold the request open — used by the interrupt probe
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse([{ type: "response.created", response: { id: "resp_hang" } }]));
        return; // never end
      }
      const events = typeof step.events === "function" ? step.events(parsed) : step.events;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(events));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

// ---------- app-server process harness ----------

function providerArgs(port) {
  // Mirrors harness.rs EnvSpec.route_args for codex
  return [
    "-c", "model_provider=modelius",
    "-c", "model_providers.modelius.name=Modelius",
    "-c", `model_providers.modelius.base_url=http://127.0.0.1:${port}/v1`,
    "-c", "model_providers.modelius.wire_api=responses",
    "-c", "model_providers.modelius.env_key=MODELIUS_GATEWAY_KEY",
  ];
}

class AppServer {
  constructor(name, { port, codexHome }) {
    this.name = name;
    this.lines = [];
    this.nextId = 1;
    this.waiters = [];
    this.capture = join(OUT, `${name}.jsonl`);
    writeFileSync(this.capture, "");
    this.codexHome = codexHome ?? join(tmpdir(), `codex-probe-${name}-${Date.now()}`);
    mkdirSync(this.codexHome, { recursive: true });
    const args = [...baseArgs, "app-server", ...(port ? providerArgs(port) : [])];
    this.child = spawn(which, args, {
      env: { ...process.env, CODEX_HOME: this.codexHome, MODELIUS_GATEWAY_KEY: "probe-token" },
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
    console.log(`  << ${l}`);
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
    this.send(params === undefined ? { id, method } : { id, method, params });
    return id;
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

  response(id, ms = 15000) {
    return this.waitFor((p) => p.id === id && (p.result !== undefined || p.error !== undefined), ms, `response #${id}`);
  }

  notification(method, ms = 15000) {
    return this.waitFor((p) => p.method === method && p.id === undefined, ms, method);
  }

  serverRequest(method, ms = 20000) {
    return this.waitFor((p) => p.method === method && p.id !== undefined, ms, `server request ${method}`);
  }

  kill() {
    try {
      this.child.kill();
    } catch {}
  }
}

function handshake(s) {
  // P1: pipelined — no awaiting between writes
  s.request("initialize", { clientInfo: { name: "modelius-probe", version: "0.0.0" } });
  s.send({ method: "initialized" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- probes ----------

async function p1() {
  console.log("\n=== P1: pipelined handshake + thread/start (no model call) ===");
  const s = new AppServer("p1", {});
  try {
    handshake(s);
    const tid = s.request("thread/start", { cwd: process.cwd(), ephemeral: true });
    const initResp = await s.response(1);
    console.log("  P1 initialize.result:", JSON.stringify(initResp.result ?? initResp.error));
    const startResp = await s.response(tid);
    console.log("  P1 RESULT: pipelining", startResp.result ? "WORKS" : `FAILED: ${JSON.stringify(startResp.error)}`);
  } finally {
    s.kill();
  }
}

async function p7() {
  console.log("\n=== P7: model/list effort tiers ===");
  const s = new AppServer("p7", {});
  try {
    handshake(s);
    const id = s.request("model/list", {});
    const resp = await s.response(id);
    console.log("  P7 RESULT:", JSON.stringify(resp.result ?? resp.error, null, 1));
  } finally {
    s.kill();
  }
}

async function p4() {
  console.log("\n=== P4: routed custom provider — HTTP? + delta notifications ===");
  const { server, port, requests } = await startFakeModel([{ events: textTurn("Hello from fake") }], console.log);
  const s = new AppServer("p4", { port });
  try {
    handshake(s);
    const tid = s.request("thread/start", {
      cwd: process.cwd(),
      model: "gpt-5.2",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    const started = await s.response(tid);
    const threadId = started.result?.thread?.id;
    console.log("  threadId:", threadId);
    // Exact param shape codex_proto::turn_start_line sends (per-turn overrides re-asserted).
    const turn = s.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "say hello" }],
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      model: "gpt-5.2",
      effort: "low",
    });
    await s.response(turn);
    const done = await s.notification("turn/completed", 30000);
    const sawDelta = s.lines.some((l) => l.method === "item/agentMessage/delta");
    const usage = s.lines.find((l) => l.method === "thread/tokenUsage/updated");
    console.log("  P4 RESULT: fake server got", requests.length, "HTTP request(s) — custom provider is",
      requests.length > 0 ? "HTTP ✓" : "NOT HTTP ✗");
    console.log("  agentMessage deltas seen:", sawDelta, "| tokenUsage:", JSON.stringify(usage?.params?.tokenUsage ?? null));
    console.log("  turn/completed:", JSON.stringify(done.params?.turn?.status), "items:", (done.params?.turn?.items ?? []).map((i) => i.type ?? i.item?.type));
  } finally {
    s.kill();
    server.close();
  }
}

async function p5() {
  console.log("\n=== P5: approval flow end-to-end (read-only + on-request) ===");
  // First model turn: a shell function call. Second: wrap-up text after the tool output.
  // shell_command arguments: `command` is a STRING (P5 stderr: "invalid type: sequence, expected a string").
  // `echo` is on codex's trusted list and auto-approves even escalated — use a non-trusted binary.
  const cmd = "node -e \"console.log('probe-ran')\"";
  // Plain safe commands auto-run even under read-only+on-request; the interactive approval fires
  // when the agent asks for escalated permissions (same as codex CLI's own "request approval" path).
  const script = [
    {
      events: (body) =>
        shellCallTurn(cmd, (body?.tools ?? []).find((t) => /shell|exec/i.test(t.name ?? ""))?.name ?? "shell", {
          sandbox_permissions: "require_escalated",
          justification: "probe needs approval card",
        }),
    },
    { events: textTurn("Command finished.") },
  ];
  const { server, port, requests } = await startFakeModel(script, console.log);
  const s = new AppServer("p5", { port });
  try {
    handshake(s);
    const tid = s.request("thread/start", {
      cwd: process.cwd(),
      model: "gpt-5.2",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    const started = await s.response(tid);
    const threadId = started.result?.thread?.id;
    s.request("turn/start", { threadId, input: [{ type: "text", text: "run the command" }] });
    const approval = await s.serverRequest("item/commandExecution/requestApproval", 30000);
    console.log("  P5 approval request:", JSON.stringify(approval));
    console.log("  P5 id typeof:", typeof approval.id);
    s.send({ id: approval.id, result: { decision: "accept" } });
    const done = await s.notification("turn/completed", 40000);
    const secondBody = requests[1]?.body;
    const fnOut = JSON.stringify(secondBody?.input ?? []).includes("probe-ran");
    console.log("  P5 RESULT: command executed (output fed back):", fnOut, "| turn status:", done.params?.turn?.status);
  } finally {
    s.kill();
    server.close();
  }
}

async function p2() {
  console.log("\n=== P2: interrupt semantics ===");
  const { server, port } = await startFakeModel([{ hang: true }], console.log);
  const s = new AppServer("p2", { port });
  try {
    handshake(s);
    const tid = s.request("thread/start", { cwd: process.cwd(), model: "gpt-5.2", sandbox: "read-only" });
    const started = await s.response(tid);
    const threadId = started.result?.thread?.id;
    const turnReq = s.request("turn/start", { threadId, input: [{ type: "text", text: "hang" }] });
    const turnStarted = await s.notification("turn/started", 15000);
    const turnId = turnStarted.params?.turn?.id ?? turnStarted.params?.turnId;
    console.log("  turn/started params:", JSON.stringify(turnStarted.params));
    await sleep(500);
    const intId = s.request("turn/interrupt", { threadId, turnId });
    const intResp = await s.response(intId, 15000);
    console.log("  P2 interrupt response:", JSON.stringify(intResp));
    const done = await s.notification("turn/completed", 15000).catch((e) => ({ timeout: String(e) }));
    console.log("  P2 RESULT turn/completed:", JSON.stringify(done.params?.turn?.status ?? done));
    // does the original turn/start request also get a response?
    const turnResp = await s.response(turnReq, 3000).catch(() => null);
    console.log("  P2 turn/start response after interrupt:", JSON.stringify(turnResp));
  } finally {
    s.kill();
    server.close();
  }
}

async function p3() {
  console.log("\n=== P3: exec-created rollout resumes in app-server ===");
  const codexHome = join(tmpdir(), `codex-probe-p3-${Date.now()}`);
  mkdirSync(codexHome, { recursive: true });
  const { server, port } = await startFakeModel(
    [{ events: textTurn("exec turn done") }, { events: textTurn("resumed turn done") }],
    console.log
  );
  try {
    // one exec --json turn (the current shipping path)
    const exec = spawnSync(
      which,
      [...baseArgs, "exec", "--json", "--skip-git-repo-check", ...providerArgs(port), "-c", 'sandbox_mode="read-only"', "--model", "gpt-5.2", "hello"],
      {
        env: { ...process.env, CODEX_HOME: codexHome, MODELIUS_GATEWAY_KEY: "probe-token" },
        encoding: "utf8",
        timeout: 60000,
        shell: false,
        windowsHide: true,
      }
    );
    appendFileSync(join(OUT, "p3-exec.jsonl"), exec.stdout ?? "");
    const threadLine = (exec.stdout ?? "").split("\n").find((l) => l.includes("thread.started"));
    const threadId = threadLine ? JSON.parse(threadLine).thread_id : null;
    console.log("  exec thread_id:", threadId, "| exec status:", exec.status);
    if (!threadId) {
      console.log("  P3 ABORT: no thread id from exec. stderr:", (exec.stderr ?? "").slice(-2000));
      return;
    }
    const s = new AppServer("p3", { port, codexHome });
    try {
      handshake(s);
      const rid = s.request("thread/resume", { threadId, cwd: process.cwd(), model: "gpt-5.2", sandbox: "read-only" });
      const resumed = await s.response(rid, 20000);
      console.log("  P3 thread/resume:", JSON.stringify(resumed.result ?? resumed.error));
      if (resumed.result) {
        s.request("turn/start", { threadId: resumed.result?.thread?.id ?? threadId, input: [{ type: "text", text: "and again" }] });
        const done = await s.notification("turn/completed", 30000);
        console.log("  P3 RESULT: resumed turn status:", done.params?.turn?.status);
      }
    } finally {
      s.kill();
    }
  } finally {
    server.close();
    rmSync(codexHome, { recursive: true, force: true });
  }
}

// ---------- main ----------

const what = process.argv[2] ?? "all";
const probes = { p1, p2, p3, p4, p5, p7 };
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
