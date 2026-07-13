// artifacts.ts — content-addressed verbatim store for large code blocks.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";
import { vaultEncrypt, vaultDecrypt } from "@/shared/api/secrets";

// Dynamic-length fence (\1 closes the open run) so code containing ``` round-trips.
const FENCE = /(`{3,})([^\n`]*)\n([\s\S]*?)\n\1/g;
const PREFIX = "modelius.artifact."; // localStorage fallback key prefix
const REF = /\[\[(code-[0-9a-f]{8})\]\]/g; // [[code-XXXX]] reference tokens

// Per-session lang map (disk file holds pure code only); "" after reload until re-parsed.
const langOf = new Map<string, string>();

// User-supplied filename → used as artifact title (fenced block carries only lang+code).
// Persisted, bounded to TITLE_CAP (oldest evicted); a dropped title degrades to content-derived.
const TITLES_KEY = PREFIX + "titles";
const TITLE_CAP = 500;

// Titles are user content (filenames) → persisted as a vault-encrypted blob, loaded into
// the in-RAM Map once at startup. Reads stay synchronous; writes persist async.
const titleOf = new Map<string, string>();
let titlesHydrated = false;
let titlesHydrating: Promise<void> | null = null;

export function hydrateTitles(): Promise<void> {
  if (titlesHydrated) return Promise.resolve();
  if (!titlesHydrating)
    titlesHydrating = (async () => {
      const raw = localStorage.getItem(TITLES_KEY);
      if (raw) {
        let plain: string;
        try {
          plain = await vaultDecrypt(raw);
        } catch {
          // Vault unavailable — DON'T latch, or persistTitles would clobber real titles. Allow a retry.
          titlesHydrating = null;
          return;
        }
        try {
          const obj = JSON.parse(plain) as Record<string, string>;
          for (const [k, v] of Object.entries(obj)) titleOf.set(k, v);
        } catch {
          /* decrypt succeeded but content is corrupt — start empty, latch below */
        }
      }
      titlesHydrated = true;
    })();
  return titlesHydrating;
}

function persistTitles(): void {
  if (!titlesHydrated) {
    void hydrateTitles(); // load failed earlier — retry rather than persist over real titles
    return;
  }
  void (async () => {
    try {
      localStorage.setItem(TITLES_KEY, await vaultEncrypt(JSON.stringify(Object.fromEntries(titleOf))));
    } catch {
      /* quota/full — names just won't survive reload */
    }
  })();
}

export function rememberArtifactTitle(id: string, title: string): void {
  if (titleOf.get(id) === title) return; // unchanged
  titleOf.delete(id); // re-insert → most-recent (Map keeps insertion order)
  titleOf.set(id, title);
  while (titleOf.size > TITLE_CAP) titleOf.delete(titleOf.keys().next().value as string);
  persistTitles();
}

// djb2 → 8 hex chars. Deterministic, no Date.now/random.
function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export const artifactId = (code: string) => "code-" + hash8(code.trim());

// Remembered file attachment (titleOf holds only real filenames) → always a card, any size.
export const isFileArtifact = (code: string) => titleOf.has(artifactId(code));

const ARTIFACT_MIN_BYTES = 4096; // 4 KB
const byteSize = (s: string) => new TextEncoder().encode(s).length;

// Human-readable size for artifact cards (e.g. "834 B", "12 KB").
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

// Longest run of consecutive backticks in s — sizes a fence that can't collide with the code.
const longestBacktickRun = (s: string) => {
  let max = 0, cur = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`") { if (++cur > max) max = cur; } else cur = 0;
  }
  return max;
};
// CommonMark fence: ≥3 backticks AND longer than any run inside the code.
export const fenceFor = (code: string) => "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
// Wrap code as a fenced block whose fence won't collide with inner backticks.
export const wrapFence = (lang: string, code: string) => {
  const f = fenceFor(code);
  return `${f}${lang}\n${code}\n${f}`;
};

// Large = many lines OR large byte size (e.g. minified JSON); else stays inline.
export const isLargeBlock = (code: string) =>
  code.split("\n").length >= 15 || byteSize(code) >= ARTIFACT_MIN_BYTES;

// A pasted blob is turned into an artifact purely by size (≥4 KB).
export const isLargePaste = (text: string) => byteSize(text) >= ARTIFACT_MIN_BYTES;

// A large block surfaced as an artifact card + viewer panel.
export interface Artifact {
  id: string;
  lang: string;
  code: string;
  lines: number;
  bytes: number;
  title: string;
}

// Fence label → canonical short id (unknown labels pass through lowercased).
const LANG_ALIAS: Record<string, string> = {
  typescript: "ts", ts: "ts", javascript: "js", js: "js", tsx: "tsx", jsx: "jsx",
  python: "py", py: "py", rust: "rs", rs: "rs", golang: "go", go: "go",
  "c++": "cpp", cpp: "cpp", "c#": "csharp", csharp: "csharp", cs: "csharp",
  shell: "bash", sh: "bash", bash: "bash", zsh: "bash", json: "json", html: "html",
  css: "css", java: "java", kotlin: "kt", kt: "kt", ruby: "rb", rb: "rb",
  yaml: "yaml", yml: "yaml", sql: "sql", markdown: "md", md: "md",
};

// Canonical id → file extension (used to title an artifact like "MemoryScreen.tsx").
const EXT: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "py", rs: "rs", go: "go",
  cpp: "cpp", csharp: "cs", bash: "sh", json: "json", html: "html", css: "css",
  java: "java", kt: "kt", rb: "rb", yaml: "yaml", sql: "sql", md: "md",
};

const hasJSX = (code: string) => /<[A-Z][\w.]*[\s/>]/.test(code) || /<\/[a-zA-Z]/.test(code) || /\/>/.test(code);

// Content sniff for the empty-fence (paste) case. Confident matches only, else "".
function sniffLang(code: string): string {
  const t = code.trimStart();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(code);
      return "json";
    } catch {
      /* not JSON */
    }
  }
  if (/^\s*(import|export)\b/m.test(code) || /\binterface\s+\w+/.test(code) || /:\s*(string|number|boolean)\b/.test(code)) return "ts";
  if (/^\s*def\s+\w+\s*\(/m.test(code) || /^\s*from\s+\w+\s+import\b/m.test(code)) return "py";
  if (/<!DOCTYPE|<html[\s>]/i.test(code)) return "html";
  return "";
}

// Canonical lang id: normalize, sniff when absent, upgrade ts/js → tsx/jsx for JSX.
export function detectLang(raw: string, code: string): string {
  const norm = raw.trim().toLowerCase();
  let lang = LANG_ALIAS[norm] ?? norm;
  if (!lang) lang = sniffLang(code);
  if ((lang === "ts" || lang === "js") && hasJSX(code)) lang += "x";
  return lang;
}

// Card title: exported symbol as Symbol.ext, else any declared symbol, else first real line.
function artifactTitle(lang: string, code: string): string {
  const sym =
    code.match(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum|struct)\s+([A-Za-z_$][\w$]*)/) ||
    code.match(/(?:def|function|class|interface|struct|fn|func|const|type)\s+([A-Za-z_$][\w$]*)/);
  if (sym) {
    const ext = EXT[lang];
    return ext ? `${sym[1]}.${ext}` : sym[1];
  }
  const line = code.split("\n").map((s) => s.trim()).find((s) => s && !/^[/#*<-]/.test(s));
  if (line) return line.length > 36 ? line.slice(0, 36) + "…" : line;
  return (lang || "code") + " snippet";
}

// View model from a fenced block. id matches the verbatim store; pass `title` to override.
export function makeArtifact(lang: string, code: string, title?: string): Artifact {
  const clean = code.replace(/\n$/, "");
  const id = artifactId(clean);
  const detected = detectLang(lang, clean);
  return {
    id,
    lang: detected,
    code: clean,
    lines: clean.split("\n").length,
    bytes: byteSize(clean),
    title: title ?? titleOf.get(id) ?? artifactTitle(detected, clean),
  };
}

export interface CodeBlock {
  lang: string;
  code: string;
  start: number;
  end: number;
}

export function parseCodeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text))) {
    out.push({ lang: m[2].trim(), code: m[3].replace(/\n$/, ""), start: m.index, end: FENCE.lastIndex });
  }
  return out;
}

// Ids of the large blocks present in `text` (e.g. to dedup against the recent verbatim window).
export const largeBlockIds = (text: string) =>
  parseCodeBlocks(text).filter((b) => isLargeBlock(b.code)).map((b) => artifactId(b.code));

export const referencedIds = (text: string) => {
  REF.lastIndex = 0;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = REF.exec(text))) ids.push(m[1]);
  return ids;
};

export const artifactLang = (id: string) => langOf.get(id) ?? "";

async function saveArtifact(id: string, code: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("artifact_write", { id, content: code });
      return;
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    localStorage.setItem(PREFIX + id, await vaultEncrypt(code));
  } catch {
    /* quota/full — drop silently, summary still carries the reference */
  }
}

export async function loadArtifact(id: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const r = await invoke<string | null>("artifact_read", { id });
      return r ?? null;
    } catch {
      return null;
    }
  }
  const raw = localStorage.getItem(PREFIX + id);
  return raw === null ? null : vaultDecrypt(raw);
}

// Create-time: persist every large block in `text`. Idempotent (content-addressed).
export async function extractAndSave(text: string): Promise<string[]> {
  const blocks = parseCodeBlocks(text).filter((b) => isLargeBlock(b.code));
  const ids: string[] = [];
  for (const b of blocks) {
    const id = artifactId(b.code);
    langOf.set(id, b.lang);
    ids.push(id);
    await saveArtifact(id, b.code);
  }
  return ids;
}

// Summarize-time: swap each large block for its [[id]] token; small blocks stay inline.
export function redactCode(text: string): { text: string; ids: string[] } {
  const blocks = parseCodeBlocks(text);
  if (!blocks.length) return { text, ids: [] };
  let out = "";
  let last = 0;
  const ids: string[] = [];
  for (const b of blocks) {
    out += text.slice(last, b.start);
    if (isLargeBlock(b.code)) {
      const id = artifactId(b.code);
      langOf.set(id, b.lang);
      out += `[[${id}]]`;
      ids.push(id);
    } else {
      out += text.slice(b.start, b.end);
    }
    last = b.end;
  }
  out += text.slice(last);
  return { text: out, ids };
}
