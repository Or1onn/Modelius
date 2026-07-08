// ModelMenu.tsx — the chat composer's model dropdown as a reusable component: trigger button +
// menu with a search filter, provider group headers, brand logos, and a paged scroll list (large
// catalogs like OpenRouter are 300+). Presentational: the caller supplies flat items and reacts
// to onSelect. Reuses the .model-pick / .model-menu styles ChatScreen introduced.
import { Fragment, useEffect, useRef, useState, type UIEvent } from "react";
import { Icon } from "@/shared/ui/Icon";
import { useOutsideClick } from "@/shared/lib/useOutsideClick";
import { PROVIDERS } from "@/entities/model/model/registry";
import { ProviderLogo } from "@/entities/model/ui/ProviderLogo";

export interface ModelMenuItem {
  key: string;
  label: string;
  group: string; // section header text — a header row renders wherever it changes
  pid: string; // provider id for the logo/color ("" → no logo)
  modelId?: string; // vendor-prefixed id (OpenRouter) — resolves the brand logo
}

const PAGE = 40;

// ProviderLogo props: OpenRouter rows resolve the icon to the id's vendor brand; everything
// else uses the provider's own logo (mirrors ChatScreen's vendorOf).
function logoProps(pid: string, modelId?: string): { pid: string; short: string; modelId?: string } {
  if (pid === "openrouter" && modelId?.includes("/")) {
    const vendor = modelId.replace(/^~/, "").split("/")[0];
    return { pid, short: vendor.slice(0, 2).toUpperCase(), modelId };
  }
  return { pid, short: PROVIDERS[pid]?.short ?? "?" };
}

export function ModelMenu({
  items,
  selectedKey,
  onSelect,
  triggerLabel,
  triggerPid,
  triggerModelId,
  footer,
}: {
  items: ModelMenuItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  triggerLabel: string;
  triggerPid?: string;
  triggerModelId?: string;
  footer?: { label: string; onSelect: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollPending = useRef(false);

  useOutsideClick(wrapRef, open, () => setOpen(false));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((it) => (it.label + " " + it.pid + " " + it.group).toLowerCase().includes(q))
    : items;

  // On open with no search, page far enough to include the selection and scroll it into view;
  // while searching, restart paging from the top.
  useEffect(() => {
    if (open && !q && selectedKey) {
      const idx = items.findIndex((it) => it.key === selectedKey);
      if (idx >= 0) {
        setShown(Math.max(PAGE, idx + PAGE));
        scrollPending.current = true;
        return;
      }
    }
    setShown(PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 32) {
      setShown((n) => (n < filtered.length ? n + PAGE : n));
    }
  };

  function pick(key: string) {
    onSelect(key);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="model-pick-wrap" ref={wrapRef}>
      <button className="model-pick on" onClick={() => setOpen((v) => !v)} title="Choose which model answers">
        {triggerPid ? (
          <span className="model-pick-logo" style={{ color: PROVIDERS[triggerPid]?.color }}>
            <ProviderLogo {...logoProps(triggerPid, triggerModelId)} />
          </span>
        ) : (
          <Icon name="providers" size={13} />
        )}
        <span className="model-pick-label">{triggerLabel}</span>
        <Icon name="chevron" size={10} style={{ transform: "rotate(90deg)", opacity: 0.6 }} />
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-menu-search">
            <Icon name="search" size={13} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              spellCheck={false}
            />
          </div>
          <div className="model-menu-scroll" onScroll={onScroll}>
            {items.length === 0 && <div className="model-menu-empty">Connect a provider to pick a model.</div>}
            {items.length > 0 && filtered.length === 0 && <div className="model-menu-empty">No models found.</div>}
            {filtered.slice(0, shown).map((it, i, arr) => (
              <Fragment key={it.key}>
                {(i === 0 || arr[i - 1].group !== it.group) && <div className="model-menu-group">{it.group}</div>}
                <button
                  ref={
                    it.key === selectedKey
                      ? (el) => {
                          if (el && scrollPending.current) {
                            scrollPending.current = false;
                            el.scrollIntoView({ block: "center" });
                          }
                        }
                      : undefined
                  }
                  className={"model-menu-item" + (it.key === selectedKey ? " on" : "")}
                  onClick={() => pick(it.key)}
                >
                  <span className="model-menu-logo" style={{ color: PROVIDERS[it.pid]?.color }}>
                    <ProviderLogo {...logoProps(it.pid, it.modelId)} />
                  </span>
                  <span style={{ flex: 1 }}>{it.label}</span>
                  <span className="model-menu-check">{it.key === selectedKey && <Icon name="check" size={12} />}</span>
                </button>
              </Fragment>
            ))}
            {shown < filtered.length && (
              <div className="model-menu-empty">Showing {shown} of {filtered.length} · scroll for more</div>
            )}
          </div>
          {footer && (
            <>
              <div className="model-menu-sep" />
              <button
                className="model-menu-item"
                onClick={() => {
                  footer.onSelect();
                  setOpen(false);
                }}
              >
                <span className="model-menu-logo"><Icon name="plus" size={14} /></span>
                <span style={{ flex: 1 }}>{footer.label}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
