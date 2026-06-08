// ModelBadge.tsx — model/provider-aware badge (knows the registry, so entity-level).
import { MODEL_BY_ID, PROVIDERS } from "@/entities/model/model/registry";

// ---------- Model badge ----------
export function ModelBadge({
  modelId,
  size = "md",
  showProvider = false,
  dim = false,
}: {
  modelId: string;
  size?: "sm" | "md" | "lg";
  showProvider?: boolean;
  dim?: boolean;
}) {
  const m = MODEL_BY_ID[modelId];
  if (!m) return null;
  const p = PROVIDERS[m.provider];
  const pad = size === "sm" ? "2px 7px 2px 6px" : size === "lg" ? "5px 12px 5px 9px" : "3px 9px 3px 7px";
  const fs = size === "sm" ? 11 : size === "lg" ? 14 : 12.5;
  return (
    <span
      className="model-badge"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: pad,
        borderRadius: "calc(var(--radius) * 0.6)",
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
      <span
        style={{
          width: size === "lg" ? 8 : 6,
          height: size === "lg" ? 8 : 6,
          borderRadius: 99,
          background: p.color,
          boxShadow: dim ? "none" : `0 0 8px ${p.color}`,
        }}
      />
      {m.name}
      {showProvider && <span style={{ color: "var(--text-3)", fontSize: fs - 1.5 }}>· {p.name}</span>}
    </span>
  );
}
