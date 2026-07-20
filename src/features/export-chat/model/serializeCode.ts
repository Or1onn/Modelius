// serializeCode.ts — turn a Code-mode chat (AI SDK UIMessage[]) into a readable Markdown
// transcript. Unlike Chat's serialize.ts (plain prose messages), a code turn is a tree of parts:
// reasoning, prose, and tool calls with inputs/outputs. We flatten that to Markdown so the whole
// run — what the agent thought, said, and did — round-trips as pasteable text.
import type { UIMessage } from "ai";

export interface CodeExportMeta {
  title: string;
  harness?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  createdAt?: number;
}

const OUTPUT_CAP = 4000; // per tool output; long file reads / logs would otherwise dominate

// Concatenate the text parts of a message (user prompt is plain text).
function textOf(m: UIMessage): string {
  return (m.parts as { type: string; text?: string }[])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function fence(body: string, lang = ""): string {
  const clipped = body.length > OUTPUT_CAP ? body.slice(0, OUTPUT_CAP) + "\n… [truncated]" : body;
  // Pick a fence long enough to survive backticks inside the payload.
  const longest = (clipped.match(/`+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}${lang}\n${clipped}\n${bar}`;
}

// The primary target shown next to a tool's name. Pattern/query outrank path: Grep carries both
// a pattern and a path, and the pattern is the search itself; ToolSearch/WebSearch only have a
// query; Agent's closest thing to a target is its short description.
function toolTarget(input: any): string {
  return String(
    input?.command ?? input?.file_path ?? input?.pattern ?? input?.query ?? input?.path ?? input?.url ?? input?.description ?? ""
  );
}

// Tool outputs arrive in several shapes depending on which harness path produced them: plain
// strings, tool_result block arrays, or the CLI's structured toolUseResult objects (Read:
// {file:{content}}, Bash: {stdout,stderr}, Agent: {content:[…final report…]}). Normalize all of
// them to readable text; unknown objects stay pretty-printed JSON.
function outputText(o: any): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((b) => (typeof b?.text === "string" ? b.text : JSON.stringify(b))).join("\n");
  if (typeof o === "object") {
    if (o.completed === true && Object.keys(o).length === 1) return ""; // synthetic edit/think marker — no real output
    if (typeof o.file?.content === "string") return o.file.content;
    if (typeof o.stdout === "string" || typeof o.stderr === "string") {
      const err = typeof o.stderr === "string" && o.stderr.trim() ? `[stderr]\n${o.stderr}` : "";
      return [o.stdout || "", err].filter(Boolean).join("\n");
    }
    if (typeof o.content === "string" || Array.isArray(o.content)) return outputText(o.content);
  }
  return JSON.stringify(o, null, 2);
}

// A tool call → Markdown: a header line (name + target) plus a body (diff for edits, else output).
function toolBlock(part: any, name: string): string {
  const input = part.input ?? {};
  const target = toolTarget(input);
  // Composite toolCallIds ("parent:child") mark calls made inside a subagent, not the main thread.
  const sub = typeof part.toolCallId === "string" && part.toolCallId.includes(":");
  const head = `**⚙ ${name}**${target ? ` \`${target}\`` : ""}${sub ? " _(subagent)_" : ""}`;

  const lower = name.toLowerCase();
  if (lower === "edit" && typeof input.old_string === "string") {
    return `${head}\n${fence(diffPatch(input.old_string, input.new_string ?? ""), "diff")}`;
  }
  if (lower === "write" && typeof input.content === "string") {
    return `${head}\n${fence(prefixLines(input.content, "+"), "diff")}`;
  }
  if (lower === "multiedit" && Array.isArray(input.edits)) {
    const patch = input.edits.map((e: any) => diffPatch(e?.old_string ?? "", e?.new_string ?? "")).join("\n");
    return `${head}\n${fence(patch, "diff")}`;
  }

  let output = "";
  if (part.state === "output-error") output = part.errorText ?? "";
  else if (part.state === "output-available") output = outputText(part.output);
  const err = part.state === "output-error" ? " (error)" : "";
  return output ? `${head}${err}\n${fence(output)}` : `${head}${err}`;
}

const prefixLines = (s: string, sign: string): string => s.split("\n").map((l) => `${sign} ${l}`).join("\n");
const diffPatch = (oldS: string, newS: string): string =>
  [oldS ? prefixLines(oldS, "-") : "", newS ? prefixLines(newS, "+") : ""].filter(Boolean).join("\n");

// One assistant message → its ordered parts as Markdown.
function assistantBody(m: UIMessage): string {
  const out: string[] = [];
  for (const p of m.parts as any[]) {
    if (p.type === "text" && p.text?.trim()) out.push(p.text.trim());
    else if (p.type === "reasoning" && p.text?.trim()) out.push(`> **Thinking**\n> ${p.text.trim().replace(/\n/g, "\n> ")}`);
    else if (p.type === "dynamic-tool" || (typeof p.type === "string" && p.type.startsWith("tool-"))) {
      const name = p.type === "dynamic-tool" ? p.toolName : p.type.slice("tool-".length);
      if (name === "Thinking") {
        if (typeof p.input?.text === "string" && p.input.text.trim()) out.push(`> **Thinking**\n> ${p.input.text.trim().replace(/\n/g, "\n> ")}`);
      } else if (name === "ExitPlanMode" && typeof p.input?.plan === "string") {
        out.push(`**📋 Plan**\n${p.input.plan.trim()}`);
      } else {
        out.push(toolBlock(p, name));
      }
    }
    // data-permission parts are transient run-time UI — never persisted, nothing to export.
  }
  return out.join("\n\n");
}

const kFmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Compact per-turn metadata footer (tokens / cost / duration / session).
function metaFooter(m: UIMessage): string {
  const md = (m.metadata ?? {}) as {
    inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number;
    totalCostUsd?: number; durationMs?: number; sessionId?: string;
  };
  const bits: string[] = [];
  if (md.inputTokens != null || md.outputTokens != null) {
    // inputTokens is the harness's uncached count (≈2 on a warm cache) — show the cached context
    // alongside, else the number reads as if the turn were nearly free.
    const cached = (md.cacheReadInputTokens ?? 0) + (md.cacheCreationInputTokens ?? 0);
    bits.push(`${md.inputTokens ?? 0} in${cached ? ` + ${kFmt(cached)} cached` : ""} / ${md.outputTokens ?? 0} out`);
  }
  if (md.totalCostUsd != null) bits.push(`$${md.totalCostUsd.toFixed(4)}`);
  // Wall-clock: spans the whole turn, including time spent waiting on the user (plan approval,
  // AskUserQuestion) — label it so it isn't read as compute time.
  if (md.durationMs != null) bits.push(`${(md.durationMs / 1000).toFixed(1)}s wall`);
  if (md.sessionId) bits.push(`session ${md.sessionId.slice(0, 8)}`);
  return bits.length ? `\n\n_${bits.join(" · ")}_` : "";
}

export function codeToMarkdown(messages: UIMessage[], meta: CodeExportMeta): string {
  const when = new Date(meta.createdAt ?? Date.now()).toLocaleString();
  const line2 = [
    meta.harness && `harness \`${meta.harness}\``,
    meta.model && `model \`${meta.model}\``,
    meta.effort && meta.effort !== "auto" && `effort \`${meta.effort}\``,
  ].filter(Boolean).join(" · ");
  const head =
    `# ${meta.title || "Code session"}\n\n*${when}*` +
    (line2 ? ` · ${line2}` : "") +
    (meta.cwd ? `\ncwd: \`${meta.cwd}\`` : "") +
    "\n";

  const body = messages
    .map((m) =>
      m.role === "user"
        ? `## 👤 User\n\n${textOf(m).trim()}`
        : `## 🤖 Assistant\n\n${assistantBody(m)}${metaFooter(m)}`
    )
    .join("\n\n---\n\n");

  return `${head}\n${body}\n`;
}
