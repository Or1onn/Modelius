// autoApprove.ts — the policy behind the "Auto" permission mode. The harness still asks (claude
// `default`, codex on-request, kimi `default`), but the app answers the safe requests itself and
// only surfaces a card for what this module flags. One policy for all three harnesses, so "Auto"
// behaves the same whichever CLI runs the chat.
// (Bypass permissions never gets here — the CLI is launched with permissions off.)

// Requests that are questions to the user, not actions: approving them automatically would answer
// on the user's behalf.
const ALWAYS_ASK = new Set(["ExitPlanMode", "AskUserQuestion"]);

// Shell commands worth a confirmation: destructive to files/history/system, or hard to undo.
const DANGEROUS: { re: RegExp; why: string }[] = [
  { re: /(^|[|&;(]\s*)(sudo|doas)\s/i, why: "runs as administrator" },
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, why: "recursive/forced delete" },
  { re: /\brmdir\b|\brd\s+\/s|\bdel\s+\/[sqf]/i, why: "deletes a directory tree" },
  { re: /\bRemove-Item\b[^|]*-(Recurse|Force)\b/i, why: "recursive/forced delete" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/i, why: "discards local work" },
  { re: /\bgit\s+push\b[^|]*(--force(?!-with-lease)|\s-f\b)/i, why: "force-pushes" },
  { re: /\b(mkfs|diskpart|fdisk|format)\b|\bdd\s+if=/i, why: "writes to a disk device" },
  { re: /\b(shutdown|reboot|Restart-Computer|Stop-Computer)\b/i, why: "shuts the machine down" },
  { re: /\btaskkill\b[^|]*\/f|\bkill\s+-9\b|\bpkill\b/i, why: "force-kills processes" },
  { re: /\breg\s+delete\b|\bRemove-ItemProperty\b/i, why: "edits the registry" },
  { re: /\b(chmod|chown|icacls|takeown)\b[^|]*(-R\b|\/t\b)/i, why: "changes permissions recursively" },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|iex|Invoke-Expression)/i, why: "pipes a download into a shell" },
  { re: /\b(npm|yarn|pnpm|cargo)\s+publish\b/i, why: "publishes a package" },
  { re: /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)/i, why: "removes containers/volumes" },
  { re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, why: "drops database data" },
];

// The command text a request carries, across the three wire dialects (claude Bash `command`,
// codex approvals `command`, kimi tool inputs `command`/`script`). Non-command requests (file
// edits, fetches) have none.
function commandOf(input: Record<string, unknown>): string {
  for (const k of ["command", "cmd", "script"]) {
    const v = input?.[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

// Why this request must still be shown to the user, or null when Auto may approve it silently.
export function dangerReason(toolName: string, input: Record<string, unknown>): string | null {
  if (ALWAYS_ASK.has(toolName)) return "needs your answer";
  const cmd = commandOf(input ?? {});
  if (!cmd) return null;
  for (const d of DANGEROUS) {
    if (d.re.test(cmd)) return d.why;
  }
  return null;
}
