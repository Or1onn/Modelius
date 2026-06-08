// ProvidersScreen.tsx — provider connections, stacked settings-list layout.
// Two sections of inner-divided rows; connect/manage happen in inline expand
// panels (no modals). Each row + its panels live in the provider-list widget.
import { useState, type ReactNode } from "react";
import { Icon } from "@/shared/ui/Icon";
import { PROVIDERS } from "@/entities/model/model/registry";
import { useKeyStore } from "@/entities/session/model/keys";
import { useAnthropicAuth } from "@/features/connect-anthropic/model/anthropicAuth";
import { useOpenAIAuth } from "@/features/connect-openai/model/openaiAuth";
import { ProviderRow } from "@/widgets/provider-list/ui/ProviderRow";

// Section layout: "Connected Accounts" = OAuth-capable or local; "API Keys" = key-only.
const SECTIONS = [
  { id: "connected", label: "Connected Accounts", collapsible: false, providers: ["anthropic", "openai", "ollama"] },
  { id: "apikeys", label: "API Keys", collapsible: true, providers: ["google", "groq"] },
] as const;

// ---------- section shell ----------
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
  const { hasKey } = useKeyStore();
  const { connected: anthConnected } = useAnthropicAuth();
  const { connected: oaiConnected } = useOpenAIAuth();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [apiOpen, setApiOpen] = useState(false);

  function isConfigured(pid: string) {
    if (PROVIDERS[pid].local) return true; // Ollama is always available on-device
    if (pid === "anthropic") return hasKey("anthropic") || anthConnected;
    if (pid === "openai") return hasKey("openai") || oaiConnected;
    return hasKey(pid);
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

        {SECTIONS.map((sec) => (
          <Section
            key={sec.id}
            label={sec.label}
            collapsible={sec.collapsible}
            open={apiOpen}
            onToggleOpen={() => setApiOpen((o) => !o)}
          >
            <div className="pv-list">
              {sec.providers.map((pid) => (
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
        ))}
      </div>
    </div>
  );
}
