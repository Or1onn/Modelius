// ProviderRow.tsx — provider settings row + inline connect/manage panels (real keys/OAuth/live models).
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { usePagedScroll } from "@/shared/lib/usePagedScroll";
import { MODELS, PROVIDERS } from "@/entities/model/model/registry";
import { ProviderLogo } from "@/entities/model/ui/ProviderLogo";
import { useKeyStore, validateKey, keyHint, maskKey } from "@/entities/session/model/keys";
import { listModels, peekModels, type RemoteModel } from "@/entities/session/api/providerModels";
import { listOllamaModels, refreshOllama, peekOllamaModels } from "@/entities/session/model/ollamaSession";
import { listKeyProviderModels, peekKeyProviderModels } from "@/entities/session/model/keyProviders";
import { listClaudeAccountModels, peekClaudeAccountModels } from "@/features/pick-backend/model/pickBackend";
import { CODEX_MODELS } from "@/entities/model/model/apiIds";
import { listAppCodexModels, peekAppCodexModels } from "@/entities/session/api/codexModels";
import { useAnthropicAuth } from "@/features/connect-anthropic/model/anthropicAuth";
import { useOpenAIAuth } from "@/features/connect-openai/model/openaiAuth";

// Reachability of the local daemon (Ollama): unknown until probed, then up/down.
export type LocalStatus = "checking" | "up" | "down";

const LIVE = new Set(["openai", "anthropic"]); // key can fetch a live model list
const KEY_LIVE = new Set(["google", "groq", "openrouter"]); // key fetches a live list over the OpenAI-compat endpoint

const TAGLINES: Record<string, string> = {
  anthropic: "Claude · claude.ai",
  openai: "GPT-4o & o3 · openai.com",
  google: "Gemini · ai.google.dev",
  groq: "LPU inference · groq.com",
  openrouter: "openrouter.ai",
  ollama: "On-device · localhost:11434",
};
const KEY_PREFIX: Record<string, string> = { openai: "sk-", anthropic: "sk-ant-", google: "AIza", groq: "gsk_", openrouter: "sk-or-" };

// Providers-page connection labels (registry name stays for badges elsewhere).
const PROVIDER_LABEL: Record<string, string> = { openai: "Codex" };
const labelOf = (pid: string) => PROVIDER_LABEL[pid] ?? PROVIDERS[pid].name;

function logoStyle(brand: string) {
  // Brand-coloured tint only feeds the initials fallback; the CDN logos sit on a clean, borderless square.
  return { color: brand, background: "transparent", border: "none" };
}

const modelsOf = (pid: string) => MODELS.filter((m) => m.provider === pid);

// One source of truth for "which model list does this provider show": the local daemon's
// installed models, an OAuth account's models, a key's live catalog — or null (static registry).
// peek() is the sync cache read for instant render; fetch() revalidates.
function providerModelSource(
  pid: string,
  viaKey: boolean,
  viaOAuth: boolean
): { peek: () => RemoteModel[] | null; fetch: () => Promise<RemoteModel[]> } | null {
  if (PROVIDERS[pid].local) return { peek: () => peekOllamaModels(), fetch: () => listOllamaModels() };
  if (viaOAuth && pid === "openai") {
    const fallback = () => CODEX_MODELS.map((m) => ({ id: m.id, name: m.name }));
    return {
      peek: () => peekAppCodexModels() ?? fallback(),
      fetch: async () => {
        const live = await listAppCodexModels();
        return live.length ? live : fallback();
      },
    };
  }
  if (viaOAuth && pid === "anthropic")
    return { peek: () => peekClaudeAccountModels(), fetch: () => listClaudeAccountModels() };
  if (KEY_LIVE.has(pid) && viaKey)
    return { peek: () => peekKeyProviderModels(pid), fetch: () => listKeyProviderModels(pid) };
  if (LIVE.has(pid) && viaKey) return { peek: () => peekModels(pid), fetch: () => listModels(pid) };
  return null;
}

// Cost tier (1–3) from the provider's priciest model; 0 = local. The registry is static,
// so tiers are computed once and cached (CostNode renders on every key/OAuth event).
const COST_TIER = new Map<string, number>();
function costTier(pid: string) {
  let t = COST_TIER.get(pid);
  if (t === undefined) {
    if (PROVIDERS[pid].local) t = 0;
    else {
      const ms = modelsOf(pid);
      const max = ms.length ? Math.max(...ms.map((m) => m.cost)) : 0;
      t = max < 0.002 ? 1 : max < 0.008 ? 2 : 3;
    }
    COST_TIER.set(pid, t);
  }
  return t;
}

function CostNode({ pid }: { pid: string }) {
  const t = costTier(pid);
  if (t === 0) return <span className="pv-free">Free · local</span>;
  return (
    <span className="prov-cost">
      {[1, 2, 3].map((i) => (
        <span key={i} className={i <= t ? "on" : "off"}>
          $
        </span>
      ))}
    </span>
  );
}

// ---------- inline connect (one component per flow) ----------

// Brand chip shown on the OAuth buttons.
function OAuthChip({ pid }: { pid: string }) {
  const p = PROVIDERS[pid];
  return (
    <span className="pv-oauth-chip" style={{ background: p.color }}>
      <ProviderLogo pid={pid} short={p.short} />
    </span>
  );
}

function OAuthError({ err }: { err: string | null }) {
  if (!err) return null;
  return (
    <div className="key-hint err">
      <Icon name="alert" size={13} />
      {err}
    </div>
  );
}

// Anthropic OAuth: open the browser, then paste the authorization code shown on the page.
function AnthropicConnect({ onConnected }: { onConnected: () => void }) {
  const { beginAnthropicLogin, completeAnthropicLogin } = useAnthropicAuth();
  const [stage, setStage] = useState<"idle" | "awaiting" | "exchanging">("idle");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setErr(null);
    try {
      await beginAnthropicLogin();
      setStage("awaiting");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't open the login page.");
    }
  }
  async function finish() {
    if (!code.trim()) return;
    setStage("exchanging");
    setErr(null);
    try {
      await completeAnthropicLogin(code);
      onConnected();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't complete sign-in.");
      setStage("awaiting");
    }
  }

  return (
    <>
      {stage === "idle" ? (
        <button className="pv-oauth" onClick={start}>
          <OAuthChip pid="anthropic" />
          Connect Claude account
        </button>
      ) : (
        <div>
          <div className="field-label">
            <Icon name="key" size={13} />
            Authorization code
          </div>
          <div className="key-input">
            <input
              autoFocus
              spellCheck={false}
              placeholder="Paste authorization code"
              value={code}
              disabled={stage === "exchanging"}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && finish()}
            />
          </div>
          <div className="key-hint">
            <Icon name="lock" size={13} />
            Authorize in your browser, then paste the code shown on the page.
          </div>
          <button
            className="prov-cta primary"
            style={{ alignSelf: "flex-start", marginTop: 10 }}
            disabled={!code.trim() || stage === "exchanging"}
            onClick={finish}
          >
            {stage === "exchanging" ? (
              <>
                <span className="mini-spin" />
                Finishing…
              </>
            ) : (
              <>
                <Icon name="check" size={15} />
                Finish sign-in
              </>
            )}
          </button>
        </div>
      )}
      <OAuthError err={err} />
    </>
  );
}

// OpenAI OAuth: one-click loopback sign-in through the system browser.
function OpenAIConnect({ onConnected }: { onConnected: () => void }) {
  const { connectOpenAI } = useOpenAIAuth();
  const [connecting, setConnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setErr(null);
    setConnecting(true);
    try {
      await connectOpenAI();
      onConnected();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <>
      <button className="pv-oauth" disabled={connecting} onClick={start}>
        {connecting ? <span className="mini-spin" /> : <OAuthChip pid="openai" />}
        {connecting ? "Waiting for browser…" : "Sign in with ChatGPT"}
      </button>
      <OAuthError err={err} />
    </>
  );
}

// API-key entry with validate → keychain store → success flash.
function KeyConnect({ pid, onConnected }: { pid: string; onConnected: () => void }) {
  const { setKey } = useKeyStore();
  const [val, setVal] = useState("");
  const [show, setShow] = useState(false);
  const [state, setState] = useState<"idle" | "error" | "success">("idle");
  const [shake, setShake] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  function fail() {
    setState("error");
    setShake(true);
    setTimeout(() => setShake(false), 450);
  }
  async function verify() {
    const v = val.trim();
    if (!validateKey(pid, v)) {
      fail();
      return;
    }
    if (!(await setKey(pid, v))) {
      fail(); // couldn't store the key securely — don't claim connected
      return;
    }
    setState("success");
    setTimeout(onConnected, 520);
  }
  const success = state === "success";

  return (
    <>
      <div>
        <div className="field-label">
          <Icon name="key" size={13} />
          Secret API key
        </div>
        <div className={"key-input" + (state === "error" ? " err" : "") + (shake ? " shake" : "")}>
          <input
            ref={ref}
            type={show ? "text" : "password"}
            spellCheck={false}
            placeholder={(KEY_PREFIX[pid] || "key") + "••••••••••••"}
            value={val}
            disabled={success}
            onChange={(e) => {
              setVal(e.target.value);
              if (state === "error") setState("idle");
            }}
            onKeyDown={(e) => e.key === "Enter" && verify()}
          />
          <button className="key-eye" tabIndex={-1} onClick={() => setShow((s) => !s)} aria-label={show ? "Hide" : "Show"}>
            <Icon name={show ? "eyeOff" : "eye"} size={16} />
          </button>
        </div>
        {state === "error" ? (
          <div className="key-hint err">
            <Icon name="alert" size={13} />
            That key doesn't look right — {keyHint(pid).toLowerCase()}
          </div>
        ) : success ? (
          <div className="key-hint ok">
            <Icon name="checkCircle" size={13} />
            Verified — connected.
          </div>
        ) : (
          <div className="key-hint">
            <Icon name="shield" size={13} />
            {keyHint(pid)}
          </div>
        )}
      </div>

      <button
        className="prov-cta primary"
        style={{ alignSelf: "flex-start" }}
        disabled={success || val.trim().length < 4}
        onClick={verify}
      >
        {success ? (
          <>
            <Icon name="check" size={15} />
            Connected
          </>
        ) : (
          <>
            <Icon name="bolt" size={15} fill />
            Verify key
          </>
        )}
      </button>
    </>
  );
}

function ConnectInline({ pid, onConnected }: { pid: string; onConnected: () => void }) {
  return (
    <div className="pv-keyform">
      {pid === "anthropic" ? (
        <AnthropicConnect onConnected={onConnected} />
      ) : pid === "openai" ? (
        <OpenAIConnect onConnected={onConnected} />
      ) : (
        <KeyConnect pid={pid} onConnected={onConnected} />
      )}
    </div>
  );
}

// Live model list + connection kind for a provider row: seeded from the cache for an instant
// render (null = cold → loading), revalidated once on mount. `keepOnError` keeps the seeded
// value on a failed fetch (the count fallback); default empties it (the manage list's "down"
// state). Shared by ManageInline (full list) and ProviderRow (count only).
function useProviderModels(
  pid: string,
  opts?: { keepOnError?: boolean; onFetched?: (ok: boolean) => void }
) {
  const local = PROVIDERS[pid].local;
  const { hasKey } = useKeyStore();
  const { connected: anthConnected } = useAnthropicAuth();
  const { connected: oaiConnected } = useOpenAIAuth();
  const viaKey = !local && hasKey(pid);
  const viaOAuth = (pid === "anthropic" && anthConnected) || (pid === "openai" && oaiConnected);
  const src = providerModelSource(pid, viaKey, viaOAuth);
  const [live, setLive] = useState<RemoteModel[] | null>(() => (src ? src.peek() : []));
  useEffect(() => {
    if (!src) return;
    let alive = true;
    src
      .fetch()
      .then((ms) => {
        if (!alive) return;
        setLive(ms);
        opts?.onFetched?.(true);
      })
      .catch(() => {
        if (!alive) return;
        if (!opts?.keepOnError) setLive([]);
        opts?.onFetched?.(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { live, setLive, viaKey, viaOAuth, hasSource: !!src };
}

// ---------- inline manage ----------
function ManageInline({
  pid,
  onDisconnected,
  onStatus,
}: {
  pid: string;
  onDisconnected: () => void;
  onStatus?: (s: LocalStatus) => void;
}) {
  const p = PROVIDERS[pid];
  const local = p.local;
  const { getKey, clearKey } = useKeyStore();
  const { connected: anthConnected, disconnectAnthropicOAuth } = useAnthropicAuth();
  const { connected: oaiConnected, disconnectOpenAIOAuth } = useOpenAIAuth();

  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null); // local daemon: null until probed
  const report = (s: LocalStatus) => {
    if (local) setReachable(s === "up");
    onStatus?.(s);
  };

  const { live, setLive, viaKey, viaOAuth } = useProviderModels(pid, {
    onFetched: (ok) => {
      if (local) report(ok ? "up" : "down"); // daemon answered → reachable (even with zero models)
    },
  });

  // Key value is in the keychain (async); load it for the masked/revealed display.
  const [keyVal, setKeyVal] = useState("");
  useEffect(() => {
    if (!viaKey || viaOAuth) return;
    let alive = true;
    void getKey(pid).then((k) => {
      if (alive) setKeyVal(k);
    });
    return () => {
      alive = false;
    };
  }, [viaKey, viaOAuth, pid, getKey]);

  async function recheckOllama() {
    setLive(null);
    try {
      setLive(await refreshOllama());
      report("up");
    } catch {
      setLive([]);
      report("down");
    }
  }

  function disconnect() {
    // Prefer disconnecting the account; a key (managed in the API Keys section) is left intact.
    if (pid === "anthropic" && anthConnected) disconnectAnthropicOAuth();
    else if (pid === "openai" && oaiConnected) disconnectOpenAIOAuth();
    else if (viaKey) clearKey(pid);
    onDisconnected();
  }

  const reg = modelsOf(pid);
  const useLive = !!live && live.length > 0;

  // Reveal the live list in pages (the full catalog is cached; large providers like OpenRouter
  // have 300+). New data restarts from the first page.
  const PAGE = 40;
  const total = live?.length ?? 0;
  const { shown, setShown, onScroll: onModelsScroll } = usePagedScroll(total, PAGE);
  useEffect(() => setShown(PAGE), [live, setShown]);

  return (
    <div className="pv-manage">
      {local ? (
        <div className="manage-row">
          <span className="manage-row-k">Runtime</span>
          <span className="manage-row-v">
            <Icon name="cpu" size={13} />
            localhost:11434 · {live === null ? "checking…" : `${live.length} model${live.length === 1 ? "" : "s"}`}
            <button className="key-eye" style={{ width: 26 }} title="Recheck" onClick={recheckOllama}>
              <Icon name="refresh" size={14} />
            </button>
          </span>
        </div>
      ) : viaKey && !viaOAuth ? (
        <div className="manage-row">
          <span className="manage-row-k">API Key</span>
          <span className="manage-row-v">
            {show ? keyVal : maskKey(keyVal)}
            <button className="key-eye" style={{ width: 26 }} tabIndex={-1} onClick={() => setShow((s) => !s)}>
              <Icon name={show ? "eyeOff" : "eye"} size={15} />
            </button>
          </span>
        </div>
      ) : (
        <div className="manage-row">
          <span className="manage-row-k">Account</span>
          <span className="manage-row-v">
            <Icon name="link" size={13} style={{ color: p.color }} />
            {pid === "anthropic" ? "Claude account connected" : "Codex account connected"}
          </span>
        </div>
      )}

      {live === null ? (
        <div className="manage-models">
          <div className="manage-model" style={{ color: "var(--text-3)", fontSize: 12.5, gap: 9 }}>
            <span className="mini-spin" />
            Fetching models…
          </div>
        </div>
      ) : local && live.length === 0 ? (
        <div className="key-hint" style={{ marginTop: 4 }}>
          <Icon name="alert" size={13} />
          {reachable === false ? (
            <>
              Ollama isn't running. Start it (<code>ollama serve</code>) — or install it from <code>ollama.com</code> — then
              recheck.
            </>
          ) : (
            <>
              No models installed. Pull one (<code>ollama pull llama3.2</code>), then recheck.
            </>
          )}
        </div>
      ) : (
        <div className="manage-models" onScroll={useLive ? onModelsScroll : undefined}>
          {useLive
            ? live!.slice(0, shown).map((m) => (
                <div key={m.id} className="manage-model">
                  <span className="manage-model-l">
                    {pid === "openrouter" ? (
                      <span className="manage-model-ico">
                        <ProviderLogo pid="openrouter" short={(m.id.replace(/^~/, "").split("/")[0] || "or").slice(0, 2).toUpperCase()} modelId={m.id} />
                      </span>
                    ) : (
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: p.color, flexShrink: 0 }} />
                    )}
                    <span style={{ fontSize: 12.5, fontFamily: "var(--font-mono)" }}>{m.name}</span>
                  </span>
                  {m.name !== m.id && (
                    <span className="manage-model-meta">
                      <span>{m.id}</span>
                    </span>
                  )}
                </div>
              ))
            : reg.map((m) => (
                <div key={m.id} className="manage-model">
                  <span className="manage-model-l">
                    <span className="prov-model-abbr" style={{ color: p.color }}>
                      {m.abbr}
                    </span>
                    <span style={{ fontSize: 12.5 }}>{m.name}</span>
                  </span>
                  <span className="manage-model-meta">
                    <span>{m.ctx}</span>
                    <span style={{ color: "var(--text-3)" }}>{m.cost === 0 ? "free" : "$" + m.cost.toFixed(4) + "/1K"}</span>
                  </span>
                </div>
              ))}
          {useLive && shown < total && (
            <div className="manage-model" style={{ justifyContent: "center", color: "var(--text-3)", fontSize: 11.5 }}>
              Showing {shown} of {total} · scroll for more
            </div>
          )}
        </div>
      )}

      {!local &&
        (confirm ? (
          <div className="manage-confirm">
            <span className="manage-confirm-t">Disconnect {labelOf(pid)}? The router will stop using its models.</span>
            <button className="mc-btn cancel" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="mc-btn confirm" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        ) : (
          <button className="pv-disconnect" onClick={() => setConfirm(true)}>
            <Icon name="xCircle" size={14} />
            Disconnect {labelOf(pid)}
          </button>
        ))}
    </div>
  );
}

// ---------- provider row ----------

// Status dot + expand toggle on the right of a row (connected/local variants).
function RowStatus({
  dot,
  label,
  expanded,
  onToggle,
}: {
  dot: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <span className={"pv-dot " + dot} />
      <button
        className="pv-config"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {label}
        <span className={"pv-chev" + (expanded ? " open" : "")}>
          <Icon name="chevron" size={13} />
        </span>
      </button>
    </>
  );
}

export function ProviderRow({
  pid,
  configured,
  expanded,
  onToggle,
  localStatus = "checking",
  onLocalStatus,
}: {
  pid: string;
  configured: boolean;
  expanded: boolean;
  onToggle: () => void;
  localStatus?: LocalStatus; // local (Ollama) daemon reachability, for the status badge
  onLocalStatus?: (s: LocalStatus) => void;
}) {
  const p = PROVIDERS[pid];
  const local = p.local;

  // Real model count: live list for providers that fetch one (Ollama, OAuth accounts, key-live
  // catalogs like OpenRouter), the static registry otherwise. keepOnError keeps the seeded
  // cache value (registry fallback) on a failed fetch.
  const { live, hasSource } = useProviderModels(pid, { keepOnError: true });
  const count = hasSource && live ? live.length : modelsOf(pid).length;

  return (
    <div className="pv-rowblock">
      <div className="pv-row clickable" onClick={onToggle}>
        <span className="prov-logo pv-logo40" style={logoStyle(p.color)}>
          <ProviderLogo pid={pid} short={p.short} />
        </span>
        <div className="pv-rowmain">
          <div className="pv-rowname">{labelOf(pid)}</div>
          <div className="pv-desc">
            <span className="pv-desc-tag">{TAGLINES[pid]}</span>
            <span className="pv-sep">·</span>
            <span>{count} models</span>
            <span className="pv-sep">·</span>
            <CostNode pid={pid} />
          </div>
        </div>
        <div className="pv-rowright">
          {local ? (
            <RowStatus
              dot={localStatus === "up" ? "green" : localStatus === "down" ? "warn" : "muted"}
              label={localStatus === "up" ? "Connected" : localStatus === "down" ? "Not running" : "Checking…"}
              expanded={expanded}
              onToggle={onToggle}
            />
          ) : configured ? (
            <RowStatus dot="green" label="Connected" expanded={expanded} onToggle={onToggle} />
          ) : (
            <button
              className="pv-connect"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            >
              <Icon name="plus" size={13} />
              Connect
            </button>
          )}
        </div>
      </div>

      <div className={"pv-collapse" + (expanded ? " open" : "")}>
        <div className="pv-collapse-inner">
          <div className="pv-expand-pad">
            {expanded &&
              (configured ? (
                <ManageInline pid={pid} onDisconnected={onToggle} onStatus={onLocalStatus} />
              ) : (
                <ConnectInline pid={pid} onConnected={onToggle} />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
