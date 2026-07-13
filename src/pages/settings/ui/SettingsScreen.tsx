// SettingsScreen.tsx — app preferences: routing policy + global custom instructions.
// Both persist via the reactive settings store and apply to every chat.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Icon } from "@/shared/ui/Icon";
import { isTauri } from "@/shared/api/tauri";
import { POLICIES, type PolicyId } from "@/entities/model/model/registry";
import { useSettings, setPolicy, setCustomInstructions, setZoom, setTheme, type ThemeId } from "@/entities/settings/model/settings";

const POLICY_ORDER: PolicyId[] = ["cost", "quality", "speed", "privacy"];
const ZOOM_PRESETS = [0.9, 1.0, 1.07, 1.15, 1.25];
const THEMES: { id: ThemeId; label: string; icon: string }[] = [
  { id: "dark", label: "Dark", icon: "moon" },
  { id: "light", label: "Light", icon: "sun" },
];

export function SettingsScreen() {
  const { policy, customInstructions, zoom, theme } = useSettings();
  const [draft, setDraft] = useState(customInstructions);

  return (
    <div className="screen">
      <div className="pv-wrap">
        <div className="screen-head">
          <div>
            <h1 className="screen-title">Settings</h1>
            <p className="screen-sub">
              How Modelius routes your turns and how the assistant behaves. Applies to every chat.
              Stored only on this device.
            </p>
          </div>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Routing policy</h2>
          <p className="set-section-sub">Which model auto-routing prefers when you haven't picked one.</p>
          <div className="policy-cards">
            {POLICY_ORDER.map((id) => {
              const p = POLICIES[id];
              const sel = policy === id;
              return (
                <button
                  key={id}
                  className={"policy-card" + (sel ? " sel" : "")}
                  onClick={() => setPolicy(id)}
                >
                  <div className="policy-card-top">
                    <span className="policy-card-icon">
                      <Icon name={p.icon} size={18} />
                    </span>
                    {sel && (
                      <span className="policy-card-check">
                        <Icon name="check" size={12} />
                      </span>
                    )}
                  </div>
                  <div className="policy-card-name">{p.label}</div>
                  <div className="policy-card-blurb">{p.blurb}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Theme</h2>
          <p className="set-section-sub">Light or dark palette. Applies instantly.</p>
          <div className="zoom-cards">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={"zoom-card" + (theme === t.id ? " sel" : "")}
                onClick={() => setTheme(t.id)}
              >
                <Icon name={t.icon} size={15} />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Interface zoom</h2>
          <p className="set-section-sub">Scale the whole UI, including text. Applies instantly.</p>
          <div className="zoom-cards">
            {ZOOM_PRESETS.map((z) => (
              <button
                key={z}
                className={"zoom-card" + (Math.abs(zoom - z) < 0.001 ? " sel" : "")}
                onClick={() => setZoom(z)}
              >
                {Math.round(z * 100)}%
                {z === 1.07 && <span className="zoom-card-tag">default</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="set-section">
          <h2 className="set-section-title">Custom instructions</h2>
          <p className="set-section-sub">
            Added to the system prompt for every chat — tone, language, role, anything the assistant
            should always follow. A per-chat persona (set from the chat header) overrides this.
          </p>
          <textarea
            className="set-instructions"
            placeholder="e.g. Always answer in Chinese. I'm a senior TypeScript developer — be concise and skip the basics."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setCustomInstructions(draft.trim())}
          />
        </div>

        {isTauri() && <EncryptionBackup />}
      </div>
    </div>
  );
}

// Passphrase-protected backup/restore of the encryption key (DEK). Chats, memory, artifacts, and
// settings are encrypted with a random key kept only in the OS keychain — if that key is lost
// (OS reset, machine move) the data is unrecoverable without a backup.
function EncryptionBackup() {
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);

  async function backup() {
    const p = pass.trim();
    if (p.length < 8) return setMsg({ err: true, text: "Use a passphrase of at least 8 characters." });
    try {
      const blob = await invoke<string>("vault_export_key", { passphrase: p });
      const path = await save({ defaultPath: "modelius-key-backup.txt", filters: [{ name: "Backup", extensions: ["txt"] }] });
      if (!path) return; // cancelled
      await writeTextFile(path, blob);
      setMsg({ err: false, text: "Backup saved. Keep the file and passphrase somewhere safe." });
    } catch (e) {
      setMsg({ err: true, text: e instanceof Error ? e.message : "Backup failed." });
    }
  }

  async function restore() {
    const p = pass.trim();
    if (!p) return setMsg({ err: true, text: "Enter the passphrase used for the backup." });
    try {
      const picked = await open({ multiple: false, filters: [{ name: "Backup", extensions: ["txt"] }] });
      if (typeof picked !== "string") return; // cancelled
      const blob = await readTextFile(picked);
      await invoke("vault_import_key", { blob, passphrase: p });
      setMsg({ err: false, text: "Key restored. Restart the app to finish decrypting your data." });
    } catch (e) {
      setMsg({ err: true, text: e instanceof Error ? e.message : "Restore failed — wrong passphrase or file?" });
    }
  }

  return (
    <div className="set-section">
      <h2 className="set-section-title">Encryption backup</h2>
      <p className="set-section-sub">
        Your chats, memory, and artifacts are encrypted with a key stored only in this device's
        keychain. If the keychain is reset or you move to a new machine, that data is
        <strong> unrecoverable without a backup.</strong> Export the key under a passphrase and keep
        it somewhere safe.
      </p>
      <div style={{ maxWidth: 420 }}>
        <div className="field-label">
          <Icon name="key" size={13} />
          Backup passphrase
        </div>
        <div className="key-input">
          <input
            type="password"
            spellCheck={false}
            placeholder="Passphrase (needed to restore)"
            value={pass}
            onChange={(e) => { setPass(e.target.value); if (msg) setMsg(null); }}
          />
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button className="btn-run" onClick={backup}>
            <Icon name="download" size={14} />
            Create backup
          </button>
          <button className="btn-ghost" onClick={restore}>Restore from file</button>
        </div>
        {msg && (
          <p className="set-section-sub" style={{ marginTop: 12, marginBottom: 0, color: msg.err ? "var(--danger)" : "var(--text-2)" }}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}
