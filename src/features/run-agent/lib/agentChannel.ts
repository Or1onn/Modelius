// agentChannel.ts — bridge the Rust `agent_run` command (AgentEvent over a Tauri Channel) into an
// async generator of transcript Steps. Mirrors stream-completion/lib/channel.ts, but yields the
// Code-mode Step union the transcript renders instead of streaming text Deltas.
import { Channel, invoke } from "@tauri-apps/api/core";
import { diffLines, type DiffRow as LineDiff } from "@/shared/lib/diff";

// Transcript step model — the shape pages/code/ui/CodeScreen.tsx renders.
export type DiffRow = { n?: number; t: "ctx" | "add" | "del"; c: string };
// A tool call row. `output` is the tool_result, filled in asynchronously (matched by `id`).
// `diff` (Edit/Write only) is computed up front from before/after text. Either is shown on expand.
export type ToolItem = { id?: string; verb: string; file: string; add?: number; del?: number; output?: string; diff?: DiffRow[] };
export type Step =
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolgroup"; items: ToolItem[] }
  | { type: "edit"; file: string; add: number; del: number }
  | { type: "diff"; path: string; rows: DiffRow[] };

// A transcript update applied to the running step list (see applyDelta).
export type StepDelta =
  | { op: "append"; step: Step }                    // prose / user turn
  | { op: "tool"; item: ToolItem }                  // a tool call (grouped with adjacent calls)
  | { op: "result"; id: string; output: string }    // fills a prior tool call's output
  | { op: "usage"; contextTokens: number; cost: number | null }; // terminal totals (not a step)

// Raw events from Rust (agent.rs AgentEvent), tagged like StreamEvent.
type AgentEvent =
  | { type: "text"; data: string }
  | { type: "thinking"; data: string }
  | { type: "tool_use"; data: { id: string; verb: string; file: string; edit: { old: string; new: string } | null } }
  | { type: "tool_result"; data: { id: string; output: string } }
  | { type: "result"; data: { model: string; cost: number | null; context_tokens: number } }
  | { type: "error"; data: string }
  | { type: "done" };

export interface RunAgentParams {
  harness: string;
  model: string;
  prompt: string;
  cwd: string;
  permissionMode: string;
  // Endpoint the run lands on (absent → the CLI's own login). Rust starts the per-run local
  // gateway between the CLI and this target; the key stays env-only, never argv.
  target?: { protocol: "anthropic" | "openai"; baseUrl: string; apiKey: string };
  // ChatGPT OAuth tokens from the app's Providers login — Rust materializes them as the codex
  // CLI's auth.json in an isolated CODEX_HOME (absent → the CLI's own `codex login`).
  codexAuth?: { idToken: string; accessToken: string; refreshToken?: string; accountId: string };
  // Claude OAuth access token from the app's Providers login — injected as CLAUDE_CODE_OAUTH_TOKEN
  // (absent → the CLI's own `claude` login).
  claudeToken?: string;
}

// Map a single agent event to a transcript delta (null = no visible change, e.g. terminal result).
function toDelta(ev: AgentEvent): StepDelta | null {
  if (ev.type === "text") return { op: "append", step: { type: "text", text: ev.data } };
  if (ev.type === "thinking") return { op: "append", step: { type: "thinking", text: ev.data } };
  if (ev.type === "tool_use") {
    const { id, verb, file, edit } = ev.data;
    const item: ToolItem = { id, verb, file };
    if (edit) {
      // A fresh Write has no old text — render every line as an addition (avoid a spurious empty del).
      const rows: LineDiff[] = edit.old === ""
        ? edit.new.split("\n").map((line, i) => ({ type: "add", text: line, newNo: i + 1 }))
        : diffLines(edit.old, edit.new);
      item.diff = rows.map((r) => ({ t: r.type, c: r.text, n: r.newNo ?? r.oldNo }));
      item.add = rows.reduce((k, r) => k + (r.type === "add" ? 1 : 0), 0);
      item.del = rows.reduce((k, r) => k + (r.type === "del" ? 1 : 0), 0);
    }
    return { op: "tool", item };
  }
  if (ev.type === "tool_result") return { op: "result", id: ev.data.id, output: ev.data.output };
  if (ev.type === "error") return { op: "append", step: { type: "text", text: `⚠️ ${ev.data}` } };
  if (ev.type === "result") return { op: "usage", contextTokens: ev.data.context_tokens, cost: ev.data.cost };
  return null; // done handled by the loop
}

// Fold a delta into the transcript: prose appends; adjacent tool calls collapse into one group;
// a result patches its matching tool item (by id) in place.
export function applyDelta(steps: Step[], d: StepDelta): Step[] {
  if (d.op === "append") {
    // Adjacent thinking segments merge into one collapsible block (like adjacent tool calls).
    const last = steps[steps.length - 1];
    if (d.step.type === "thinking" && last?.type === "thinking")
      return [...steps.slice(0, -1), { ...last, text: `${last.text}\n\n${d.step.text}` }];
    return [...steps, d.step];
  }
  if (d.op === "tool") {
    const last = steps[steps.length - 1];
    if (last?.type === "toolgroup")
      return [...steps.slice(0, -1), { ...last, items: [...last.items, d.item] }];
    return [...steps, { type: "toolgroup", items: [d.item] }];
  }
  if (d.op !== "result") return steps; // usage: session-level, not a step
  return steps.map((s) =>
    s.type === "toolgroup" && s.items.some((it) => it.id === d.id)
      ? { ...s, items: s.items.map((it) => (it.id === d.id ? { ...it, output: d.output } : it)) }
      : s
  );
}

// Drive one harness turn. Yields transcript deltas as they stream; ends on done/error.
// Abort → tell Rust to cancel (cancel_stream by id) and stop consuming.
export async function* runAgentToSteps(params: RunAgentParams, streamId: string, signal?: AbortSignal): AsyncGenerator<StepDelta> {
  const channel = new Channel<AgentEvent>();
  const queue: StepDelta[] = [];
  let finished = false;
  let wake: (() => void) | null = null;
  const ping = () => {
    wake?.();
    wake = null;
  };

  if (signal) {
    const onAbort = () => {
      finished = true;
      void invoke("cancel_stream", { streamId }).catch(() => {});
      ping();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  channel.onmessage = (ev) => {
    if (ev.type === "done") {
      finished = true;
    } else {
      const delta = toDelta(ev);
      if (delta) queue.push(delta);
      if (ev.type === "error") finished = true; // error is terminal; a done still follows but stop here
    }
    ping();
  };

  const call = invoke("agent_run", {
    harness: params.harness,
    model: params.model,
    prompt: params.prompt,
    cwd: params.cwd,
    permissionMode: params.permissionMode,
    target: params.target,
    codexAuth: params.codexAuth,
    claudeToken: params.claudeToken,
    streamId,
    onEvent: channel,
  });
  call.catch(() => {
    finished = true;
    ping();
  });

  while (true) {
    if (queue.length) {
      yield queue.shift() as StepDelta;
      continue;
    }
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await call.catch(() => {});
}
