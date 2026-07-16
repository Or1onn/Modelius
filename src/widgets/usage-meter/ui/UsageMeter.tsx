// UsageMeter.tsx — the Chat header context-fill meter: a thin bar + token readout (unchanged look)
// that opens a popover with the account's remaining limits. What shows depends on how the chat is
// powered: subscription → session/weekly windows (bars); API key → $ spent (+ provider balance).
import { useEffect, useRef, useState } from "react";
import { fmtCompact } from "@/shared/lib/tokens";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { refreshUsage, useUsageLimits, useUsageFetching, useSpend } from "@/entities/session/model/usageLimits";
import { fmtReset, fmtUsd, winUsedPct } from "../lib/format";

export function UsageMeter({ used, win, providerKey, model }: { used: number; win: number; providerKey?: string; model?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, open, () => setOpen(false));
  const snap = useUsageLimits(providerKey);
  const spend = useSpend(providerKey);
  const fetching = useUsageFetching(providerKey);
  const windows = snap?.windows ?? [];
  const balance = snap?.balanceUsd;
  const pct = win > 0 ? used / win : 0;
  const level = pct >= 0.85 ? "high" : pct >= 0.5 ? "mid" : "low";

  // Subscription windows / balance are lazy fetches — refresh them when the popover opens.
  useEffect(() => {
    if (open) void refreshUsage(providerKey, model);
  }, [open, providerKey, model]);

  return (
    <div className="ctx-meter-wrap" ref={ref}>
      <button
        className="ctx-meter"
        data-level={level}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => void refreshUsage(providerKey, model)}
        title={`Context: ${Math.round(used).toLocaleString()} / ${win.toLocaleString()} tokens`}
      >
        <span className="ctx-meter-bar">
          <span className="ctx-meter-fill" style={{ width: Math.min(100, pct * 100) + "%" }} />
        </span>
        <span className="ctx-meter-label">
          {fmtCompact(used)} / {fmtCompact(win)} · {Math.round(pct * 100)}%
        </span>
      </button>
      {open && (
        <div className="ctx-pop">
          <div className="ctx-pop-row">
            <span>Context window</span>
            <span>{Math.round(pct * 100)}%</span>
          </div>
          <div className="ctx-pop-bar" data-level={level}>
            <span style={{ width: Math.min(100, pct * 100) + "%" }} />
          </div>
          <div className="ctx-pop-sub">
            {fmtCompact(used)} / {fmtCompact(win)} tokens
          </div>

          {/* Probe in flight with nothing cached yet — show a placeholder, not an empty gap. */}
          {windows.length === 0 && fetching && (
            <div className="ctx-pop-plan">
              <div className="ctx-pop-plan-head">Plan usage limits</div>
              <div className="ctx-pop-sub">Loading…</div>
            </div>
          )}

          {/* Subscription rate-limit windows, one labelled bar each (Claude Code's "Plan usage limits"). */}
          {windows.length > 0 && (
            <div className="ctx-pop-plan">
              <div className="ctx-pop-plan-head">Plan usage limits</div>
              {windows.map((w, i) => {
                const u = winUsedPct(w);
                const reset = fmtReset(w.resetsAt);
                const lvl = u == null ? undefined : u >= 90 ? "crit" : u >= 75 ? "warn" : undefined;
                return (
                  <div className="ctx-pop-win" key={i}>
                    <div className="ctx-pop-win-top">
                      <span className="ctx-pop-win-label">{w.label}</span>
                      <span className="ctx-pop-win-meta">
                        {reset && <em>{reset}</em>}
                        <b>{u != null ? `${u}%` : "—"}</b>
                      </span>
                    </div>
                    <div className="ctx-pop-bar" data-level={lvl}><span style={{ width: `${u ?? 0}%` }} /></div>
                  </div>
                );
              })}
            </div>
          )}

          {spend > 0 && (
            <div className="ctx-pop-row"><span>Spent (Modelius)</span><span>{fmtUsd(spend)}</span></div>
          )}
          {balance && (
            <div className="ctx-pop-row">
              <span>Balance</span>
              <span>{balance.limit != null ? `${fmtUsd(balance.usage)} / ${fmtUsd(balance.limit)}` : `${fmtUsd(balance.usage)} used`}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
