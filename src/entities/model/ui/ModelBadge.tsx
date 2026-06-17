// ModelBadge.tsx — registry-aware model/provider badge.
import { MODEL_BY_ID, PROVIDERS, type Model } from "@/entities/model/model/registry";
import { ProviderLogo } from "@/entities/model/ui/ProviderLogo";

export function ModelBadge({
  modelId,
  model,
  label,
  provider,
  size = "md",
  showProvider = false,
  dim = false,
}: {
  modelId?: string;
  model?: Model; // off-registry models (live/custom) pass the full object
  label?: string; // off-registry by raw label + provider (manual pick / backend name not in registry)
  provider?: string;
  size?: "sm" | "md" | "lg";
  showProvider?: boolean;
  dim?: boolean;
}) {
  const m = model ?? (modelId ? MODEL_BY_ID[modelId] : undefined);
  const name = m?.name ?? label;
  const providerId = m?.provider ?? provider ?? "";
  if (!name) return null;
  const p = PROVIDERS[providerId] ?? {
    id: providerId,
    name: providerId,
    color: "var(--accent)",
    short: name.slice(0, 2).toUpperCase(),
    local: false,
  };
  const pad = size === "sm" ? "2px 7px 2px 6px" : size === "lg" ? "5px 12px 5px 9px" : "3px 9px 3px 7px";
  const fs = size === "sm" ? 11 : size === "lg" ? 14 : 12.5;
  const logoSz = size === "sm" ? 14 : size === "lg" ? 18 : 15;
  return (
    <span
      className="model-badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: pad,
        borderRadius: "var(--r-xs)",
        fontFamily: "var(--font-mono)",
        fontSize: fs,
        fontWeight: 500,
        letterSpacing: "-0.01em",
        color: dim ? "var(--text-3)" : "var(--text-1)",
        background: dim ? "transparent" : `color-mix(in oklab, ${p.color} 12%, transparent)`,
        border: `1px solid ${dim ? "var(--border)" : `color-mix(in oklab, ${p.color} 32%, transparent)`}`,
        whiteSpace: "nowrap",
      }}
    >
      <span className="badge-logo" style={{ width: logoSz, height: logoSz, fontSize: logoSz - 5, color: p.color }}>
        <ProviderLogo pid={p.id} short={p.short} />
      </span>
      {name}
      {showProvider && <span style={{ color: "var(--text-3)", fontSize: fs - 1.5 }}>· {p.name}</span>}
    </span>
  );
}
