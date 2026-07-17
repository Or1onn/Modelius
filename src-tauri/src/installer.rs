// Every harness ships as a global
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
    let spec = harness::all().iter().find(|h| h.bin == bin);
    // Managed native binary wins: fastest to spawn (no node shim) and version-pinned.
    if let Some(p) = spec.and_then(|s| native_bin(app, s)) {
        return Some(p);
    }
    if let Some(dir) = node_runtime::agents_bin_dir(app) {
        if let Some(p) = bin_in_dir(&dir, bin) {
            return Some(p);
        }
    }
    which::which(bin).ok()
}

// ---- managed native binaries (harness.native_dist) ----

// The dist's platform directory names match the Claude CLI release conventions.
#[cfg(all(windows, target_arch = "x86_64"))]
const NATIVE_PLATFORM: &str = "win32-x64";
#[cfg(all(windows, target_arch = "aarch64"))]
const NATIVE_PLATFORM: &str = "win32-arm64";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const NATIVE_PLATFORM: &str = "darwin-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const NATIVE_PLATFORM: &str = "darwin-x64";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const NATIVE_PLATFORM: &str = "linux-x64";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const NATIVE_PLATFORM: &str = "linux-arm64";

fn native_bin_name(bin: &str) -> String {
    if cfg!(windows) {
        format!("{bin}.exe")
    } else {
        bin.to_string()
    }
}

// <app-data>/native/<bin>/<version>/ — version in the path so a pin bump is a clean side-by-side
// install, never an in-place overwrite of a running binary.
fn native_dir(app: &tauri::AppHandle, spec: &harness::HarnessSpec) -> Option<PathBuf> {
    use tauri::Manager;
    let dist = spec.native_dist.as_ref()?;
    Some(app.path().app_data_dir().ok()?.join("native").join(spec.bin).join(dist.version))
}

pub(crate) fn native_bin(app: &tauri::AppHandle, spec: &harness::HarnessSpec) -> Option<PathBuf> {
    let p = native_dir(app, spec)?.join(native_bin_name(spec.bin));
    p.is_file().then_some(p)
}

// Whether a resolved program is one of our managed native binaries — those need no Node at all,
// so agent_run skips the node acceptability probe entirely.
pub(crate) fn is_native_install(app: &tauri::AppHandle, program: &std::path::Path) -> bool {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|d| program.starts_with(d.join("native")))
        .unwrap_or(false)
}

fn manifest_url(dist: &harness::NativeDist) -> String {
    format!("{}/{}/manifest.json", dist.base, dist.version)
}

fn binary_url(dist: &harness::NativeDist, platform: &str, binary: &str) -> String {
    format!("{}/{}/{}/{}", dist.base, dist.version, platform, binary)
}

// Download the pinned native binary: manifest → binary → sha256 verify → atomic rename.
// Transfer integrity comes from the checksum; authenticity rests on TLS to the official origin
// (the same trust model as the vendor's install script).
async fn install_native(
    app: &tauri::AppHandle,
    spec: &harness::HarnessSpec,
    dist: &harness::NativeDist,
) -> Result<PathBuf, String> {
    let manifest: serde_json::Value = crate::stream::http_client()
        .get(manifest_url(dist))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("failed to fetch the release manifest: {e}"))?
        .json()
        .await
        .map_err(|e| format!("bad release manifest: {e}"))?;
    let plat = &manifest["platforms"][NATIVE_PLATFORM];
    let expected = plat["checksum"]
        .as_str()
        .ok_or_else(|| format!("release has no {NATIVE_PLATFORM} build"))?
        .to_lowercase();
    let bin_name = native_bin_name(spec.bin);
    let remote_name = plat["binary"].as_str().unwrap_or(bin_name.as_str());

    let dir = native_dir(app, spec).ok_or("no app data dir")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create install dir: {e}"))?;
    let part = dir.join(format!("{bin_name}.part"));
    let dest = dir.join(&bin_name);

    // Stream to disk hashing as we go (the binary is ~250MB — never buffer it whole).
    let mut res = crate::stream::http_client()
        .get(binary_url(dist, NATIVE_PLATFORM, remote_name))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("failed to download {}: {e}", spec.bin))?;
    let mut hasher = {
        use sha2::Digest;
        sha2::Sha256::new()
    };
    {
        use sha2::Digest;
        use std::io::Write;
        let mut file = std::fs::File::create(&part).map_err(|e| format!("failed to write download: {e}"))?;
        while let Some(chunk) = res.chunk().await.map_err(|e| format!("download interrupted: {e}"))? {
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| format!("failed to write download: {e}"))?;
        }
        file.flush().map_err(|e| format!("failed to write download: {e}"))?;
    }
    let actual = {
        use sha2::Digest;
        format!("{:x}", hasher.finalize())
    };
    if actual != expected {
        let _ = std::fs::remove_file(&part);
        return Err(format!("checksum mismatch for {} (expected {expected}, got {actual}) — download corrupted?", spec.bin));
    }
    std::fs::rename(&part, &dest).map_err(|e| format!("failed to finalize install: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("failed to mark executable: {e}"))?;
    }
    Ok(dest)
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

// Best-effort "already signed in via the CLI's own login" check: presence of the spec's
// credential files. False negatives are possible (e.g. macOS keychain-backed logins), so
// callers should offer a bypass rather than hard-block.
#[tauri::command]
pub async fn harness_logged_in(app: tauri::AppHandle, harness: String) -> Result<bool, String> {
    use tauri::Manager;
    let spec = harness::spec(&harness).ok_or_else(|| format!("unknown harness: {harness}"))?;
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

    // Native dist first (no Node/npm involved); any failure falls back to the npm path and is
    // only surfaced if that fails too.
    let mut native_err: Option<String> = None;
    if let Some(dist) = &spec.native_dist {
        match install_native(&app, spec, dist).await {
            Ok(_) => return Ok(resolve_bin(&app, spec.bin).is_some()),
            Err(e) => native_err = Some(e),
        }
    }

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
        let mut msg = if tail.is_empty() { format!("installer exited with {}", out.status) } else { tail };
        if let Some(ne) = native_err {
            msg = format!("{msg}\n(native install also failed: {ne})");
        }
        return Err(msg);
    }
    Ok(resolve_bin(&app, spec.bin).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same digest+encoding install_native computes incrementally over the download stream.
    fn sha256_hex(data: &[u8]) -> String {
        use sha2::Digest;
        format!("{:x}", sha2::Sha256::digest(data))
    }

    #[test]
    fn dist_urls_follow_the_release_layout() {
        let dist = harness::NativeDist { base: "https://dist.example/releases", version: "2.1.206" };
        assert_eq!(manifest_url(&dist), "https://dist.example/releases/2.1.206/manifest.json");
        assert_eq!(
            binary_url(&dist, "win32-x64", "claude.exe"),
            "https://dist.example/releases/2.1.206/win32-x64/claude.exe"
        );
    }

    #[test]
    fn sha256_hex_matches_the_manifest_encoding() {
        // Known vector — the manifest carries lowercase hex sha256, which is what we compare.
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_ne!(sha256_hex(b"abd"), sha256_hex(b"abc")); // corruption is detected
    }

    #[test]
    fn native_bin_name_is_platform_correct() {
        if cfg!(windows) {
            assert_eq!(native_bin_name("claude"), "claude.exe");
        } else {
            assert_eq!(native_bin_name("claude"), "claude");
        }
    }
}
