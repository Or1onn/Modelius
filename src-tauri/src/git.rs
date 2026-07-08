// git.rs — minimal read/switch of the workspace's git branches for Code mode's branch picker.
// Both commands resolve `git` on PATH and run it in `cwd`. Any failure (git missing, not a repo,
// dirty tree on checkout) is surfaced as an Err the front end can swallow — a non-git folder just
// yields an empty branch list, which hides the picker.
use tokio::process::Command;

#[derive(serde::Serialize)]
pub(crate) struct GitInfo {
    current: String,
    branches: Vec<String>,
}

fn git_bin() -> Result<std::path::PathBuf, String> {
    which::which("git").map_err(|_| "git not found on PATH".to_string())
}

async fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let bin = git_bin()?;
    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// List local branches + the current one. Errors (non-repo, git missing) become an empty list.
#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<GitInfo, String> {
    if cwd.is_empty() {
        return Ok(GitInfo { current: String::new(), branches: vec![] });
    }
    let current = run(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let list = run(&cwd, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .await
        .unwrap_or_default();
    let branches = list.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    Ok(GitInfo { current, branches })
}

// Switch branches. Propagates git's error (e.g. uncommitted changes) so the UI can revert its pick.
#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    run(&cwd, &["checkout", &branch]).await.map(|_| ())
}
