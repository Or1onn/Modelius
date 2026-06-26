// ApiKeys.tsx — API Keys section: paste any provider key (provider auto-detected from its signature),
// then manage stored keys via the shared ProviderRow.
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { PROVIDERS } from "@/entities/model/model/registry";
import { useKeyStore, detectProvider, validateKey } from "@/entities/session/model/keys";
import { isKeyProvider, listKeyProviderModels } from "@/entities/session/model/keyProviders";
import { ProviderRow } from "@/widgets/provider-list/ui/ProviderRow";

// Providers connectable via an API key (OAuth-only/local providers live in other sections).
const KEY_PROVIDERS = ["openai", "anthropic", "google", "groq", "openrouter"];

function AddKeyForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { setKey } = useKeyStore();
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const k = val.trim();
  const detected = k ? detectProvider(k) : null;

  async function add() {
    const pid = detectProvider(k);
    if (!pid || !validateKey(pid, k)) {
      setErr("Unrecognized key — supported: OpenAI, Anthropic, Google, Groq, OpenRouter.");
      return;
    }
    await setKey(pid, k);
    if (isKeyProvider(pid)) void listKeyProviderModels(pid).catch(() => {}); // warm the live list
    onDone();
  }

  return (
    <div className="pv-keyform">
      <div>
        <div className="field-label">
          <Icon name="key" size={13} />
          API key
        </div>
        <div className={"key-input" + (err ? " err" : "")}>
          <input
            autoFocus
            type="password"
            spellCheck={false}
            placeholder="Paste a key — the provider is detected automatically"
            value={val}
            onChange={(e) => {
              setVal(e.target.value);
              if (err) setErr(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <div className={"key-hint" + (err ? " err" : detected ? " ok" : "")}>
          {err ? (
            <>
              <Icon name="alert" size={13} />
              {err}
            </>
          ) : detected ? (
            <>
              <Icon name="checkCircle" size={13} />
              Detected provider: {PROVIDERS[detected].name}
            </>
          ) : (
            <>
              <Icon name="shield" size={13} />
              The provider is recognized from the key's signature.
            </>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="prov-cta primary" disabled={!detected} onClick={add}>
          <Icon name="check" size={15} />
          Add key
        </button>
        <button className="prov-cta" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ApiKeys() {
  const { hasKey } = useKeyStore();
  const stored = KEY_PROVIDERS.filter((p) => hasKey(p));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="pv-list">
      {stored.map((pid) => (
        <ProviderRow
          key={pid}
          pid={pid}
          configured
          expanded={expanded === pid}
          onToggle={() => setExpanded((x) => (x === pid ? null : pid))}
        />
      ))}

      {stored.length === 0 && !adding && (
        <div className="key-hint" style={{ padding: "10px 12px" }}>
          <Icon name="key" size={13} />
          No keys yet — add one and the router will use it.
        </div>
      )}

      {adding ? (
        <div className="pv-rowblock">
          <div className="pv-expand-pad" style={{ paddingTop: 14 }}>
            <AddKeyForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
          </div>
        </div>
      ) : (
        <button className="pv-connect" style={{ alignSelf: "flex-start", margin: "4px 12px 12px" }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          Add API key
        </button>
      )}
    </div>
  );
}
