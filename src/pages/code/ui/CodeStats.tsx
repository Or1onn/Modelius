// CodeStats.tsx — Code mode's new-session empty state: a greeting + a usage-statistics card with
// an Overview (stat grid + activity heat) and Models tab, filterable by All / 30d / 7d. All figures
// are aggregated from real stored code sessions (see model/codeUsage.ts).
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { ProviderLogo } from "@/entities/model/ui/ProviderLogo";
import { PROVIDERS, MODEL_BY_ID } from "@/entities/model/model/registry";
import {
  useCodeUsage, computeStats, computeModelUsage, computeHeat, usageFoot,
  STAT_ORDER, type RangeId,
} from "@/pages/code/model/codeUsage";

// Provider mark: the bare brand logo (used by the Models list and the "working" badge).
// `modelId` (vendor-prefixed, e.g. "x-ai/grok-4.5") resolves the model's own brand instead of the
// aggregator's (OpenRouter). The wrapper only sizes the mark and colors the initials fallback.
export function PLogo({ pid, modelId }: { pid: string; modelId?: string }) {
  const p = PROVIDERS[pid];
  if (!p) return <span>?</span>;
  return (
    <span className="cd-plogo" style={{ color: p.color }}>
      <ProviderLogo pid={pid} short={p.short} modelId={modelId} />
    </span>
  );
}

const modelName = (id: string) => MODEL_BY_ID[id]?.name ?? id;

export function CodeStats() {
  const { sessions } = useCodeUsage();
  const [tab, setTab] = useState<"overview" | "models">("overview");
  const [range, setRange] = useState<RangeId>("All");

  const stats = computeStats(sessions, range, modelName);
  const heat = computeHeat(sessions, range);
  const foot = usageFoot(sessions, range);
  const models = computeModelUsage(sessions, range);

  return (
    <div className="cd-hero">
      <div className="cd-hero-greet">
        <span className="cd-hero-spark"><Icon name="spark" size={30} stroke={1.8} /></span>
        <h1>What’s up next?</h1>
      </div>
      <div className="cd-stats-card">
        <div className="cd-stats-head">
          <div className="cd-stats-tabs">
            <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
            <button className={tab === "models" ? "on" : ""} onClick={() => setTab("models")}>Models</button>
          </div>
          <div className="cd-stats-range">
            {(["All", "30d", "7d"] as RangeId[]).map((r) => (
              <button key={r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
        </div>

        {tab === "overview" ? (
          <>
            <div className="cd-stats-grid">
              {STAT_ORDER.map((k) => (
                <div key={k} className="cd-stat">
                  <div className="cd-stat-k">{k}</div>
                  <div className="cd-stat-v">{stats[k]}</div>
                </div>
              ))}
            </div>
            <div className="cd-heat">
              {heat.map((row, ri) => (
                <div key={ri} className="cd-heat-row">
                  {row.map((v, ci) => <span key={ci} className={"cd-heat-cell l" + v} />)}
                </div>
              ))}
            </div>
            {foot && <div className="cd-stats-foot">{foot}</div>}
          </>
        ) : models.length === 0 ? (
          <div className="cd-stats-foot">No model usage yet.</div>
        ) : (
          <div className="cd-models-list">
            {models.map((u) => {
              const m = MODEL_BY_ID[u.id];
              const color = m ? PROVIDERS[m.provider]?.color : undefined;
              return (
                <div key={u.id} className="cd-mrow">
                  <PLogo pid={m?.provider ?? ""} />
                  <span className="cd-mname">{m?.name ?? u.id}</span>
                  <span className="cd-mbar"><span style={{ width: u.pct + "%", background: color }} /></span>
                  <span className="cd-mtok mono">{u.tokens}</span>
                  <span className="cd-mpct mono">{u.pct}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
