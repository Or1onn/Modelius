// ProviderLogo.tsx — provider/company brand icons served from the TheSVG CDN (no bundled files).
// The slug is the provider id, or — for aggregator (OpenRouter) models "vendor/model" — the id's
// vendor prefix. A few ids differ from TheSVG's slug; those are remapped. On a CDN miss, shows initials.
import { useEffect, useRef, useState } from "react";

const THESVG = "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons";

// provider id / OpenRouter vendor prefix → TheSVG slug, where they differ.
const SLUG: Record<string, string> = {
  anthropic: "claude", // company id → the Claude product mark
  google: "gemini", // provider id → the Gemini brand
  "meta-llama": "meta",
  mistralai: "mistral",
  "x-ai": "xai",
  "bytedance-seed": "bytedance",
  "z-ai": "zhipu",
  moonshotai: "moonshot",
  allenai: "ai2",
  "arcee-ai": "arcee",
};

// The TheSVG slug for a logo. Aggregator models carry their brand in the id's "vendor/" prefix
// (a leading "~" marks auto-updating "-latest" aliases — strip it); otherwise use the provider id.
function slugFor(pid: string, modelId?: string): string {
  if (modelId && modelId.includes("/")) {
    const v = modelId.split("/")[0].toLowerCase().replace(/^~/, "");
    return SLUG[v] ?? v;
  }
  const k = pid.toLowerCase();
  return SLUG[k] ?? k;
}

// Many brand marks are a single flat color (OpenAI = white, OpenRouter = white, …) that vanishes
// against one theme's background. CSS can't tell the icon's color, so we inspect the SVG once per
// slug and classify its tone: "light" (all near-white) or "dark" (all near-black). A light mark is
// inverted to black under the light theme; a dark mark is inverted to white under dark — see the
// .cdn-logo.tone-* rules in styles.css. Multi-color logos (Claude, Gemini, Mistral) resolve to null
// and are never touched. One fetch per slug per session.
type Tone = "light" | "dark" | null;
const toneCache = new Map<string, Tone>();
const inflight = new Map<string, Promise<Tone>>();
const IGNORE = new Set(["none", "transparent", "currentcolor", "inherit"]);

// Luminance (0..1) of a solid color token, or null for a named/non-solid color (→ treat as colored).
function luminance(v: string): number | null {
  if (v === "white") return 1;
  if (v === "black") return 0;
  if (v[0] === "#") {
    let h = v.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join(""); // #rgb(a) → #rrggbb(aa)
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  const rgb = v.match(/^rgba?\((\d+),(\d+),(\d+)/);
  if (rgb) return (0.299 * +rgb[1] + 0.587 * +rgb[2] + 0.114 * +rgb[3]) / 255;
  return null; // named color (gold, red, …) — not monochrome black/white
}

async function detectTone(url: string): Promise<Tone> {
  const svg = await fetch(url).then((r) => (r.ok ? r.text() : ""));
  // Both fill and stroke decide a mark's color (OpenRouter is drawn with strokes).
  const tokens = [...svg.matchAll(/(?:fill|stroke)\s*[:=]\s*["']?\s*([#\w(),.%-]+)/gi)]
    .map((m) => m[1].toLowerCase().replace(/\s+/g, ""))
    .filter((v) => !IGNORE.has(v));
  if (!tokens.length) return null;
  const lums: number[] = [];
  for (const t of tokens) {
    const l = luminance(t);
    if (l == null) return null; // a real color present → leave the logo alone
    lums.push(l);
  }
  if (lums.every((l) => l >= 0.85)) return "light";
  if (lums.every((l) => l <= 0.15)) return "dark";
  return null;
}

function loadTone(slug: string, url: string): Promise<Tone> {
  const hit = toneCache.get(slug);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(slug);
  if (!p) {
    p = detectTone(url)
      .catch(() => null)
      .then((v) => {
        toneCache.set(slug, v);
        inflight.delete(slug);
        return v;
      });
    inflight.set(slug, p);
  }
  return p;
}

// `short` (initials) shows until the CDN icon loads, and stays if it's missing/slow/errors — the
// jsDelivr fetch can be slow or fail, and waiting only for onError leaves an empty slot meanwhile.
// A cold jsDelivr edge often 404s/times-out the first hit then serves it warm, so onError retries a
// couple times (cache-busted so the browser refetches) before settling on initials.
const RETRIES = 2;
export function ProviderLogo({ pid, short, modelId }: { pid: string; short: string; modelId?: string }) {
  const slug = slugFor(pid, modelId);
  const [attempt, setAttempt] = useState(0);
  const url = `${THESVG}/${slug}/default.svg${attempt ? `?r=${attempt}` : ""}`;
  // The url whose icon finished loading. Derived, not reset in an effect: a cached icon can fire
  // `load` before the mount's passive effects flush, and a `setLoaded(false)` there would clobber it
  // — with no second `load` coming, the initials would stick forever.
  const [okUrl, setOkUrl] = useState<string | null>(null);
  const loaded = okUrl === url; // a new slug/attempt re-shows the initials on its own
  const [tone, setTone] = useState<Tone>(() => toneCache.get(slug) ?? null);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setAttempt(0), [slug]); // fresh retry budget when the icon changes (instance reused in a list)
  useEffect(() => () => clearTimeout(retryTimer.current), []);

  useEffect(() => {
    let alive = true;
    void loadTone(slug, url).then((v) => alive && setTone(v));
    return () => {
      alive = false;
    };
  }, [slug, url]);

  return (
    <>
      {!loaded && short}
      <img
        className={"cdn-logo" + (tone ? " tone-" + tone : "")}
        src={url}
        alt=""
        aria-hidden="true"
        style={loaded ? undefined : { display: "none" }}
        onLoad={() => setOkUrl(url)}
        onError={() => {
          if (attempt < RETRIES) {
            clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => setAttempt((a) => a + 1), 500 * (attempt + 1));
          }
        }}
      />
    </>
  );
}
