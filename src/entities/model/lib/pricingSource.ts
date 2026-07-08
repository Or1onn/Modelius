// pricingSource.ts — live per-token prices from OpenRouter's public model catalog (no official
// provider pricing API exists). Cached in localStorage (24h); pricing.ts overlays it on the static
// table, so an unmatched model still falls back to a hardcoded rate.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/api/tauri";

const OR_BASE = "https://openrouter.ai/api/v1"; // compat_list_models appends /models
const STORE_KEY = "modelius.pricing.openrouter";
const TTL = 1000 * 60 * 60 * 24; // prices change rarely — refresh daily

type Rate = { in: number; out: number };
interface ORModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}
// Cached catalog data: per-token rates + reasoning/vision/image-output capability flags per normalized id.
interface Catalog {
  rates: Record<string, Rate>;
  caps: Record<string, boolean>;
  vis: Record<string, boolean>;
  imgOut: Record<string, boolean>;
}

// Normalize to the bare model slug so a provider-prefixed OpenRouter id (e.g. "google/gemini-2.5-flash")
// matches our resolved id ("gemini-2.5-flash"). Strips the prefix and any punctuation.
function norm(id: string): string {
  return id.toLowerCase().split("/").pop()!.replace(/[^a-z0-9]/g, "");
}

// Parsed-catalog memo: the accessors below run in hot paths (routing, render), so re-parsing the
// multi-KB JSON per call is wasteful. Re-parses only when the stored string changes.
let memoRaw: string | null = null;
let memoAt = 0;
let memoCatalog: Catalog | null = null;

function read(): Catalog | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    if (raw !== memoRaw) {
      memoRaw = raw;
      memoCatalog = null;
      const e = JSON.parse(raw) as { at: number; rates?: Record<string, Rate>; caps?: Record<string, boolean>; vis?: Record<string, boolean>; imgOut?: Record<string, boolean> };
      // `rates`/`caps`/`vis`/`imgOut` absent → an older cache shape; treat as stale so it's refetched.
      if (e.rates && e.caps && e.vis && e.imgOut) {
        memoAt = e.at;
        memoCatalog = { rates: e.rates, caps: e.caps, vis: e.vis, imgOut: e.imgOut };
      }
    }
    if (memoCatalog && Date.now() - memoAt < TTL) return memoCatalog;
  } catch {
    /* ignore */
  }
  return null;
}

// Fetch OpenRouter's catalog and cache normalized per-1M rates. Best-effort: on any failure the
// last cache (or the static table) stays in use. OpenRouter prices are USD per token → ×1e6.
export async function loadDynamicPricing(): Promise<void> {
  if (read()) return; // fresh enough
  try {
    const json = isTauri()
      ? await invoke<{ data?: ORModel[] }>("compat_list_models", { baseUrl: OR_BASE, apiKey: "" })
      : await fetch(`${OR_BASE}/models`).then((r) => r.json());
    const rates: Record<string, Rate> = {};
    const caps: Record<string, boolean> = {};
    const vis: Record<string, boolean> = {};
    const imgOut: Record<string, boolean> = {};
    for (const m of (json.data ?? []) as ORModel[]) {
      caps[norm(m.id)] = (m.supported_parameters ?? []).includes("reasoning");
      vis[norm(m.id)] = (m.architecture?.input_modalities ?? []).includes("image");
      imgOut[norm(m.id)] = (m.architecture?.output_modalities ?? []).includes("image");
      const pin = parseFloat(m.pricing?.prompt ?? "");
      const pout = parseFloat(m.pricing?.completion ?? "");
      if (!Number.isFinite(pin) || !Number.isFinite(pout) || (pin === 0 && pout === 0)) continue;
      rates[norm(m.id)] = { in: pin * 1e6, out: pout * 1e6 };
    }
    if (Object.keys(caps).length) localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), rates, caps, vis, imgOut }));
  } catch {
    /* offline / blocked — keep static pricing */
  }
}

// Live rate for a resolved API id, or undefined if not in the catalog. Sync (cache peek).
export function dynamicRate(modelId: string): Rate | undefined {
  return read()?.rates[norm(modelId)];
}

// Whether the model supports reasoning, per OpenRouter's catalog. true/false when the model is
// known; undefined when it isn't in the catalog (caller decides the fallback). Sync (cache peek).
export function supportsReasoning(modelId: string): boolean | undefined {
  return read()?.caps[norm(modelId)];
}

// Whether the model accepts image input, per OpenRouter's catalog. true/false when the model
// is known; undefined when it isn't in the catalog (caller decides the fallback). Sync (cache peek).
export function supportsVision(modelId: string): boolean | undefined {
  return read()?.vis[norm(modelId)];
}

// Whether the model can generate images, per OpenRouter's catalog. true/false when the model
// is known; undefined when it isn't in the catalog (caller decides the fallback). Sync (cache peek).
export function supportsImageOutput(modelId: string): boolean | undefined {
  return read()?.imgOut[norm(modelId)];
}
