// GatewayModal.tsx — add / remove model endpoints for Code mode. A gateway declares which
// protocol it speaks: the Anthropic Messages API (LiteLLM proxy, DeepSeek /anthropic, Z.ai,
// Moonshot, …) or OpenAI chat/completions (any compat endpoint). The API key goes straight to
// the OS keychain via addGateway and is never held anywhere else; the inputs clear on save.
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import { addGateway, removeGateway, useGateways, type GatewayProtocol } from "@/entities/agent/model/gateways";

export function GatewayModal({ onClose }: { onClose: () => void }) {
  const gateways = useGateways();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState<GatewayProtocol>("anthropic");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const valid = name.trim() && /^https?:\/\//.test(baseUrl.trim()) && apiKey.trim() && model.trim();

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setError("");
    try {
      await addGateway(
        { name: name.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, ""), model: model.trim(), protocol },
        apiKey.trim()
      );
      setName("");
      setBaseUrl("");
      setApiKey("");
      setModel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gw-box">
        <div className="gw-head">
          <span>Model gateways</span>
          <button className="gw-close" onClick={onClose} title="Close"><Icon name="close" size={15} /></button>
        </div>
        <div className="gw-body">
          <p className="gw-hint">
            Any model endpoint works — pick the protocol it speaks. Anthropic Messages API: a LiteLLM
            proxy, DeepSeek (<span className="mono">https://api.deepseek.com/anthropic</span>), Z.ai,
            Moonshot… OpenAI compatible: any <span className="mono">/chat/completions</span> endpoint.
            The API key is stored in the OS keychain.
          </p>
          <div className="gw-form">
            <div className="gw-proto">
              <button
                className={"gw-proto-btn" + (protocol === "anthropic" ? " on" : "")}
                onClick={() => setProtocol("anthropic")}
              >
                Anthropic Messages API
              </button>
              <button
                className={"gw-proto-btn" + (protocol === "openai" ? " on" : "")}
                onClick={() => setProtocol("openai")}
              >
                OpenAI compatible
              </button>
            </div>
            <input className="gw-input" placeholder="Name (e.g. DeepSeek)" value={name} onChange={(e) => setName(e.target.value)} />
            <input
              className="gw-input mono"
              placeholder={protocol === "anthropic" ? "Base URL — https://api.deepseek.com/anthropic" : "Base URL — https://api.example.com/v1"}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <input className="gw-input mono" type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
            <input className="gw-input mono" placeholder="Model id (e.g. deepseek-chat)" value={model} onChange={(e) => setModel(e.target.value)} />
            {error && <div className="gw-error">⚠️ {error}</div>}
            <button className="gw-add" disabled={!valid || saving} onClick={() => void save()}>
              {saving ? "Adding…" : "Add gateway"}
            </button>
          </div>
          {gateways.length > 0 && (
            <div className="gw-list">
              {gateways.map((g) => (
                <div key={g.id} className="gw-row">
                  <span className="gw-row-main">
                    <span className="gw-row-name">{g.name}</span>
                    <span className="gw-row-sub mono">{g.model} · {g.protocol === "openai" ? "openai" : "anthropic"} · {g.baseUrl}</span>
                  </span>
                  <button className="gw-del" title="Remove" onClick={() => void removeGateway(g.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
