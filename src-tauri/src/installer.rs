// installer.rs — harness CLI detection + one-click install. Every harness ships as a global
// npm package, so install is one data-driven path: `npm install -g <spec.npm_pkg>`. Detection
// uses the same resolution agent_run spawns with, so "installed" here means "spawnable".
// npm comes from the system when its Node is acceptable, otherwise from the managed portable
// runtime (node_runtime.rs), installing into the isolated agents prefix.
use std::path::PathBuf;
use std::time::Duration;

use crate::{harness, node_runtime};

// Where a harness bin actually lives: the managed agents prefix first (CLIs installed with the
// portable runtime), then the spec's vendor-install hint dirs (their PATH edits land in the
// registry/profile, which this process's PATH snapshot predates), then the system PATH.
// Mirrored by agent_run's spawn resolution.
fn bin_in_dir(dir: &std::path::Path, bin: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        for ext in ["cmd", "exe"] {
            let p = dir.join(format!("{bin}.{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
        None
    } else {
        let p = dir.join(bin);
        p.is_file().then_some(p)
    }
}

pub(crate) fn resolve_bin(app: &tauri::AppHandle, bin: &str) -> Option<PathBuf> {
    if let Some(dir) = node_runtime::agents_bin_dir(app) {
        if let Some(p) = bin_in_dir(&dir, bin) {
            return Some(p);
        }
    }
    if let Some(spec) = harness::all().iter().find(|h| h.bin == bin) {
        use tauri::Manager;
        if let Ok(home) = app.path().home_dir() {
            for hint in spec.bin_hint {
                if let Some(p) = bin_in_dir(&home.join(hint), bin) {
                    return Some(p);
                }
            }
        }
    }
    which::which(bin).ok()
}

#[derive(serde::Serialize)]
pub(crate) struct HarnessStatus {
    pub id: &'static str,
    pub installed: bool,
}

#[tauri::command]
pub async fn harness_status(app: tauri::AppHandle) -> Vec<HarnessStatus> {
    harness::all()
        .iter()
        .map(|h| HarnessStatus { id: h.id, installed: resolve_bin(&app, h.bin).is_some() })
        .collect()
}

// Best-effort "already signed in via the CLI's own login" check. Preferred signal is the spec's
// login_probe (a CLI command that exits 0 only when authenticated — keyring-backed logins leave
// no file); fallback is the presence of the spec's credential files. False negatives are possible
// (e.g. macOS keychain-backed logins), so callers should offer a bypass rather than hard-block.
#[tauri::command]
pub async fn harness_logged_in(app: tauri::AppHandle, harness: String) -> Result<bool, String> {
    use tauri::Manager;
    let spec = harness::spec(&harness).ok_or_else(|| format!("unknown harness: {harness}"))?;
    if !spec.login_probe.is_empty() {
        let Some(bin) = resolve_bin(&app, spec.bin) else { return Ok(false) };
        let mut cmd = tokio::process::Command::new(bin);
        cmd.args(spec.login_probe)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let st = tokio::time::timeout(Duration::from_secs(20), cmd.status()).await;
        return Ok(matches!(st, Ok(Ok(s)) if s.success()));
    }
    let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
    Ok(spec.login_marker.iter().any(|m| home.join(m).exists()))
}

// Install one harness CLI. Ok(true) = bin resolves after install; Ok(false) = the installer
// succeeded but the bin still can't be resolved (e.g. it landed on a PATH this process hasn't
// seen); Err = installer failed / Node download failed. Every harness ships as a global npm
// package — system npm when its Node is acceptable, else the portable runtime into the isolated
// agents prefix. All argv content is static (see the BatBadBut note on spawn() in agent.rs) — no
// user-controlled strings reach the command line.
#[tauri::command]
pub async fn harness_install(app: tauri::AppHandle, harness: String) -> Result<bool, String> {
    let spec = harness::spec(&harness).ok_or_else(|| format!("unknown harness: {harness}"))?;

    let harness::Install::Npm(pkg) = &spec.install;
    let system_npm =
        if node_runtime::system_node_acceptable() { which::which("npm").ok() } else { None };
    let (npm, managed) = match system_npm {
        Some(p) => (p, false),
        None => {
            node_runtime::ensure(&app).await?;
            let p = node_runtime::managed_npm(&app)
                .ok_or_else(|| "managed Node runtime is missing npm".to_string())?;
            (p, true)
        }
    };
    let mut cmd = tokio::process::Command::new(npm);
    cmd.args(["install", "-g", pkg]);
    if managed {
        let prefix = node_runtime::agents_prefix(&app)?;
        std::fs::create_dir_all(&prefix)
            .map_err(|e| format!("failed to create agents dir: {e}"))?;
        cmd.arg("--prefix").arg(&prefix);
        if let Some(path) = node_runtime::child_path_env(&app) {
            cmd.env("PATH", path); // npm's shims need the portable node first
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let out = tokio::time::timeout(Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| "install timed out after 10 minutes".to_string())
        .and_then(|r| r.map_err(|e| format!("failed to run the installer: {e}")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.trim().chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(if tail.is_empty() { format!("installer exited with {}", out.status) } else { tail });
    }
    Ok(resolve_bin(&app, spec.bin).is_some())
}
