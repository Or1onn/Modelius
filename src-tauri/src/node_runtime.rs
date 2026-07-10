// node_runtime.rs — managed portable Node.js for the agent harnesses. Every harness CLI is a Node
// program installed via npm; when the user's system Node is missing or broken (< 22.19, or 24.17.x
// whose CVE-2026-48931 fix breaks node-fetch/gaxios — the qwen HTTP stack), we download a
// pinned portable build into app-data and (a) run npm installs with it into an isolated prefix,
// (b) prepend it to spawned CLIs' PATH so their `node` shims pick it up — which also heals CLIs
// that were already installed with the system npm.
use std::path::PathBuf;
use tauri::Manager;

const NODE_VERSION: &str = "24.18.0"; // first release with the node-fetch regression fix

#[cfg(all(windows, target_arch = "x86_64"))]
const PLATFORM: &str = "win-x64";
#[cfg(all(windows, target_arch = "aarch64"))]
const PLATFORM: &str = "win-arm64";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const PLATFORM: &str = "darwin-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const PLATFORM: &str = "darwin-x64";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const PLATFORM: &str = "linux-x64";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const PLATFORM: &str = "linux-arm64";

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("no app data dir: {}", e))
}

// <app-data>/node-runtime/node-v{V}-{platform}
fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("node-runtime"))
}

fn dist_dir_name() -> String {
    format!("node-v{}-{}", NODE_VERSION, PLATFORM)
}

// Directory holding the `node` executable (and npm shims on Windows).
pub(crate) fn managed_node_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let root = runtime_root(app).ok()?.join(dist_dir_name());
    let dir = if cfg!(windows) { root } else { root.join("bin") };
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    node.is_file().then_some(dir)
}

// Isolated npm --prefix for CLIs installed with the managed runtime. Windows npm puts the shims
// directly in the prefix dir; Unix under bin/.
pub(crate) fn agents_prefix(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("agents"))
}

pub(crate) fn agents_bin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let p = agents_prefix(app).ok()?;
    Some(if cfg!(windows) { p } else { p.join("bin") })
}

// PATH value for spawned CLIs / npm: managed node dir + agents bin dir ahead of the inherited
// PATH. None when no managed runtime is installed (system PATH is fine as-is).
pub(crate) fn child_path_env(app: &tauri::AppHandle) -> Option<std::ffi::OsString> {
    let node_dir = managed_node_dir(app)?;
    let mut parts: Vec<PathBuf> = vec![node_dir];
    if let Some(b) = agents_bin_dir(app) {
        parts.push(b);
    }
    if let Some(cur) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&cur));
    }
    std::env::join_paths(parts).ok()
}

// System `node --version` (None when not installed / not runnable).
pub(crate) fn system_node_version() -> Option<String> {
    let node = which::which("node").ok()?;
    let out = std::process::Command::new(node).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// Whether a "vX.Y.Z" is safe for the harness CLIs: require >= 22.19, and reject 24.17.x, which
// ships the CVE-2026-48931 change that breaks node-fetch (some CLIs hang on every request).
pub(crate) fn version_acceptable(v: &str) -> bool {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let major: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    if major < 22 || (major == 22 && minor < 19) {
        return false;
    }
    major != 24 || minor != 17
}

// How long a probe result stays valid. Long enough that a turn never pays the subprocess twice,
// short enough that a user who installs/fixes Node mid-session is picked up without a restart.
const NODE_CHECK_TTL: std::time::Duration = std::time::Duration::from_secs(600);

fn cache_fresh(at: std::time::Instant, now: std::time::Instant) -> bool {
    now.duration_since(at) < NODE_CHECK_TTL
}

pub(crate) fn system_node_acceptable() -> bool {
    // Cached: this spawns `node --version`, and agent_run consults it on every npm-harness turn.
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, bool)>> = std::sync::Mutex::new(None);
    let now = std::time::Instant::now();
    let mut slot = CACHE.lock().unwrap();
    if let Some((at, ok)) = *slot {
        if cache_fresh(at, now) {
            return ok;
        }
    }
    let ok = system_node_version().as_deref().is_some_and(version_acceptable);
    *slot = Some((now, ok));
    ok
}

// Download + extract the pinned portable Node (idempotent; serialized against concurrent calls).
pub(crate) async fn ensure(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _g = LOCK.lock().await;
    if let Some(dir) = managed_node_dir(app) {
        return Ok(dir);
    }

    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let url = format!(
        "https://nodejs.org/dist/v{v}/node-v{v}-{p}.{ext}",
        v = NODE_VERSION,
        p = PLATFORM,
        ext = ext
    );
    let bytes = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("failed to download Node.js: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("failed to download Node.js: {}", e))?;

    let root = runtime_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| format!("failed to create runtime dir: {}", e))?;

    let root2 = root.clone();
    tauri::async_runtime::spawn_blocking(move || extract(&bytes, &root2))
        .await
        .map_err(|e| e.to_string())??;

    managed_node_dir(app).ok_or_else(|| "Node.js archive did not contain the expected layout".to_string())
}

#[cfg(windows)]
fn extract(bytes: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("bad Node.js archive: {}", e))?;
    zip.extract(dest).map_err(|e| format!("failed to extract Node.js: {}", e))
}

#[cfg(not(windows))]
fn extract(bytes: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    tar::Archive::new(gz)
        .unpack(dest)
        .map_err(|e| format!("failed to extract Node.js: {}", e))
}

// npm entrypoint of the managed runtime (npm.cmd next to node.exe on Windows, bin/npm on Unix).
pub(crate) fn managed_npm(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = managed_node_dir(app)?;
    let npm = dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" });
    npm.is_file().then_some(npm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_acceptable_enforces_the_harness_node_floor() {
        assert!(version_acceptable("v22.19.0"));
        assert!(version_acceptable("v24.16.0"));
        assert!(version_acceptable("v24.18.0"));
        assert!(!version_acceptable("v22.18.0")); // below 22.19
        assert!(!version_acceptable("v20.0.0")); // major too low
        assert!(!version_acceptable("v24.17.1")); // the blocked CVE build
    }

    #[test]
    fn node_check_cache_expires_on_ttl() {
        let now = std::time::Instant::now();
        assert!(cache_fresh(now, now));
        assert!(cache_fresh(now, now + NODE_CHECK_TTL - std::time::Duration::from_secs(1)));
        assert!(!cache_fresh(now, now + NODE_CHECK_TTL));
    }
}
