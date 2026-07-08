// AuthModal.tsx — sign-in modal for native harness runs (Code mode). Shown when the picked model
// runs on the CLI's own account but neither the app's connection nor the CLI's credentials are
// present. Anthropic is two-step (browser → paste code), ChatGPT/Codex is one-shot (loopback
// callback). "Continue anyway" bypasses the gate: CLI-login detection is best-effort (e.g.
// keyring-backed logins) and must never hard-block.
import { useState } from "react";
import { Icon } from "@/shared/ui/Icon";
import type { NativeKind } from "@/entities/agent/model/harnesses";
import { beginAnthropicLogin, completeAnthropicLogin } from "@/features/connect-anthropic/model/anthropicAuth";
import { connectOpenAI } from "@/features/connect-openai/model/openaiAuth";

export function AuthModal({ kind, harnessName, onClose, onDone }: {
  kind: NativeKind;
  harnessId: string;
  harnessName: string;
  onClose: () => void;
  onDone: () => void; // signed in (or bypassed) — caller re-sends
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [codeStep, setCodeStep] = useState(false); // anthropic: browser opened, awaiting pasted code
  const [code, setCode] = useState("");

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const startAnthropic = () =>
    run(async () => {
      await beginAnthropicLogin();
      setCodeStep(true);
    });

  const finishAnthropic = () =>
    run(async () => {
      await completeAnthropicLogin(code);
      onDone();
    });

  const startCodex = () =>
    run(async () => {
      await connectOpenAI();
      onDone();
    });

  return (
    <div className="search-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gw-box am-box">
        <div className="gw-head">
          <span>Sign in — {harnessName}</span>
          <button className="gw-close" onClick={onClose} title="Close"><Icon name="close" size={15} /></button>
        </div>
        <div className="gw-body">
          {kind === "anthropic" && (
            <>
              <p className="gw-hint">
                {harnessName} runs on your Claude account. Sign in once — the login is shared with
                the Providers page and stored in the OS keychain.
              </p>
              {!codeStep ? (
                <button className="gw-add am-cta" disabled={busy} onClick={startAnthropic}>
                  {busy ? "Opening browser…" : "Sign in with Claude"}
                </button>
              ) : (
                <div className="gw-form">
                  <p className="gw-hint">Approve in the browser, then paste the authorization code here.</p>
                  <input
                    className="gw-input mono"
                    placeholder="Paste code…"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoFocus
                  />
                  <button className="gw-add am-cta" disabled={busy || !code.trim()} onClick={finishAnthropic}>
                    {busy ? "Connecting…" : "Connect"}
                  </button>
                </div>
              )}
            </>
          )}
          {kind === "codex" && (
            <>
              <p className="gw-hint">
                {harnessName} runs on your ChatGPT account. Sign in once — the login is shared with
                the Providers page and stored in the OS keychain.
              </p>
              <button className="gw-add am-cta" disabled={busy} onClick={startCodex}>
                {busy ? "Waiting for browser sign-in…" : "Sign in with ChatGPT"}
              </button>
            </>
          )}
          {error && <div className="gw-error">⚠️ {error}</div>}
          <button className="am-skip" onClick={onDone}>
            Already signed in? Continue anyway
          </button>
        </div>
      </div>
    </div>
  );
}
