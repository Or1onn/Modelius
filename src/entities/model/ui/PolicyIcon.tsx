// PolicyIcon.tsx — routing-policy toggle button (knows POLICIES, so entity-level).
import { POLICIES, type PolicyId } from "@/entities/model/model/registry";
import { Icon } from "@/shared/ui/Icon";

// ---------- Policy icon button (used in selector) ----------
export function PolicyIcon({
  policy,
  active,
  onClick,
  compact = false,
}: {
  policy: PolicyId;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  const p = POLICIES[policy];
  return (
    <button
      onClick={onClick}
      title={`${p.label} — ${p.blurb}`}
      className="policy-icon"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 0 : 7,
        padding: compact ? "7px" : "7px 11px 7px 9px",
        borderRadius: "calc(var(--radius)*0.7)",
        cursor: "pointer",
        border: `1px solid ${active ? "color-mix(in oklab, var(--accent) 45%, transparent)" : "transparent"}`,
        background: active ? "color-mix(in oklab, var(--accent) 14%, transparent)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-3)",
        fontFamily: "var(--font-ui)",
        fontSize: 12.5,
        fontWeight: 500,
        transition: "all .16s ease",
      }}
    >
      <Icon name={p.icon} size={15} stroke={active ? 1.9 : 1.6} />
      {!compact && p.label}
    </button>
  );
}
