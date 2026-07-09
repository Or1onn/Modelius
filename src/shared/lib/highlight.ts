// highlight.ts — single source of syntax highlighting for tool blocks (diffs, Read output).
// Emits highlight.js token markup (`.hljs-*`), styled by the global github-dark theme imported
// in App.tsx — the same tokens the markdown code blocks and the ArtifactPanel already render.
import hljs from "highlight.js";

// file extension → highlight.js language id (only common ones; unknown ⇒ no highlight).
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php",
  json: "json", jsonc: "json", css: "css", scss: "scss", less: "less", html: "xml", xml: "xml", svg: "xml",
  md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// hljs language id for a file path, or undefined when the extension is unknown / not a path.
export function langFromPath(file?: string): string | undefined {
  const ext = file?.split(".").pop()?.toLowerCase();
  return ext ? EXT_LANG[ext] : undefined;
}

// Highlighted HTML for `code` in `lang` (hljs token markup), or the escaped text when the
// language is unknown/unregistered. Safe to inject via dangerouslySetInnerHTML.
export function highlightHtml(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  return escapeHtml(code);
}
