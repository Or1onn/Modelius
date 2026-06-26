// ProviderLogo.tsx — provider/company brand icons served from the TheSVG CDN (no bundled files).
// The slug is the provider id, or — for aggregator (OpenRouter) models "vendor/model" — the id's
// vendor prefix. A few ids differ from TheSVG's slug; those are remapped. On a CDN miss, shows initials.
import { useEffect, useState } from "react";

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

// short: initials shown when the CDN has no icon for this slug.
export function ProviderLogo({ pid, short, modelId }: { pid: string; short: string; modelId?: string }) {
  const slug = slugFor(pid, modelId);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [slug]); // retry when the slug changes (instance reused in a list)

  if (failed) return <>{short}</>;
  return <img src={`${THESVG}/${slug}/default.svg`} alt="" aria-hidden="true" onError={() => setFailed(true)} />;
}
