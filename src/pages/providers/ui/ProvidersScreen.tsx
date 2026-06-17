// ProvidersScreen.tsx — provider connections in two settings-list sections; rows live in the provider-list widget.
import { useState, type ReactNode } from "react";
import { Icon } from "@/shared/ui/Icon";
import { PROVIDERS } from "@/entities/model/model/registry";
import { useAnthropicAuth } from "@/features/connect-anthropic/model/anthropicAuth";
import { useOpenAIAuth } from "@/features/connect-openai/model/openaiAuth";
import { ProviderRow } from "@/widgets/provider-list/ui/ProviderRow";
import { ApiKeys } from "@/widgets/provider-list/ui/ApiKeys";

// Connected via a linked account (OAuth) or on-device. Keys live in the API Keys section.
const ACCOUNT_PROVIDERS = ["anthropic", "openai", "ollama"];

// ---- section shell ----
function Section({
  label,
  collapsible,
  open,
  onToggleOpen,
  children,
}: {
  label: string;
  collapsible: boolean;
  open: boolean;
  onToggleOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pv-section">
      <div className="pv-sechead">
        {collapsible ? (
          <button className="pv-sectoggle" onClick={onToggleOpen}>
            <span className={"pv-secchev" + (open ? " open" : "")}>
              <Icon name="chevron" size={13} />
            </span>
            <span className="pv-seclabel">{label}</span>
          </button>
        ) : (
          <div className="pv-sectoggle static">
            <span className="pv-seclabel">{label}</span>
          </div>
        )}
      </div>
      {collapsible ? (
        <div className={"pv-collapse" + (open ? " open" : "")}>
          <div className="pv-collapse-inner">{children}</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function ProvidersScreen() {
  const { connected: anthConnected } = useAnthropicAuth();
  const { connected: oaiConnected } = useOpenAIAuth();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [apiOpen, setApiOpen] = useState(false);

  // Account section reflects a linked account / on-device only — keys are handled in the API Keys section.
  function isConfigured(pid: string) {
    if (PROVIDERS[pid].local) return true; // Ollama always available on-device
    if (pid === "anthropic") return anthConnected;
    if (pid === "openai") return oaiConnected;
    return false;
  }

  const toggle = (pid: string) => setExpanded((x) => (x === pid ? null : pid));

  return (
    <div className="screen">
      <div className="pv-wrap">
        <div className="screen-head">
          <div>
            <h1 className="screen-title">Providers</h1>
            <p className="screen-sub">
              Connect AI providers and let the router pick the best model per request. Bring your own keys or link an
              account — inference never touches our servers.
            </p>
          </div>
        </div>

        <Section label="Connected Accounts" collapsible={false} open onToggleOpen={() => {}}>
          <div className="pv-list">
            {ACCOUNT_PROVIDERS.map((pid) => (
              <ProviderRow
                key={pid}
                pid={pid}
                configured={isConfigured(pid)}
                expanded={expanded === pid}
                onToggle={() => toggle(pid)}
              />
            ))}
          </div>
        </Section>

        <Section label="API Keys" collapsible open={apiOpen} onToggleOpen={() => setApiOpen((o) => !o)}>
          <ApiKeys />
        </Section>
      </div>
    </div>
  );
}
