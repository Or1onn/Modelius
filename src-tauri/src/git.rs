// git.rs — the workspace's git branches for Code mode's branch picker, plus the worktree
// isolation flow (a chat works on its own branch in a checkout under app-data, leaving the
// user's tree untouched). Every command resolves `git` on PATH and runs it in a given dir.
// Any failure (git missing, not a repo, dirty tree on checkout) is surfaced as an Err the front
// end can swallow — a non-git folder just yields an empty branch list, which hides the picker.
use std::path::{Path, PathBuf};
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
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(cwd);
    // A git hook exports GIT_DIR/GIT_INDEX_FILE/… to its children; inheriting them would aim these
    // calls at the hook's repo instead of `cwd`. Always resolve the repo from `cwd` alone.
    for k in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        cmd.env_remove(k);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// Non-repo / missing git degrade to an empty list rather than an error.
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

// ---- worktree isolation ----
// A chat can run against its own `git worktree` instead of the user's folder: a separate checkout
// on a fresh branch, living under app-data. The main tree keeps its branch and its uncommitted
// work; the agent's edits land on the new branch only. Note the checkout holds *committed* content
// only — no node_modules, no .env — which the UI states up front.

#[derive(serde::Serialize, Clone)]
pub(crate) struct WorktreeInfo {
    path: String,   // the isolated checkout the agent runs in
    branch: String, // the branch created for it
    base: String,   // what it was branched from
    repo: String,   // the main working tree it belongs to
}

#[derive(serde::Serialize)]
pub(crate) struct FileChange {
    status: String, // porcelain XY code ("M ", "??", "R "…)
    path: String,
}

#[derive(serde::Serialize)]
pub(crate) struct WorktreeStatus {
    files: Vec<FileChange>,
    ahead: u32,     // commits on the branch that the base doesn't have
    diff: String,   // unified diff of the checkout (working tree included) against the base
    truncated: bool,
}

// Cap the diff handed to the webview — a huge refactor would otherwise stall the panel.
const DIFF_LIMIT: usize = 400_000;

// Windows git prints forward slashes; hand the CLIs a native path so `cd`-style tooling agrees.
fn native_path(p: &str) -> String {
    if cfg!(windows) { p.replace('/', "\\") } else { p.to_string() }
}

// Cyrillic → latin, so a Russian prompt still yields a usable branch. The front end asks a cheap
// model for an English name first; this is the offline path, where dropping the letters outright
// would leave an empty slug. Anything else non-ASCII becomes a separator.
fn translit(ch: char) -> &'static str {
    match ch.to_lowercase().next().unwrap_or(ch) {
        'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' | 'ё' | 'э' => "e",
        'ж' => "zh", 'з' => "z", 'и' | 'і' => "i", 'й' | 'ы' => "y", 'к' => "k", 'л' => "l",
        'м' => "m", 'н' => "n", 'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t",
        'у' => "u", 'ф' => "f", 'х' => "h", 'ц' => "c", 'ч' => "ch", 'ш' => "sh", 'щ' => "sch",
        'ю' => "yu", 'я' => "ya", 'ъ' | 'ь' => "",
        _ => "",
    }
}

// Branch/directory name from free text. ASCII only — a Cyrillic branch name reads badly in
// `git branch` and in any tooling that assumes latin refs.
fn slugify(s: &str) -> String {
    const MAX: usize = 32;
    let mut out = String::new();
    let mut gap = false; // separator owed, emitted only once a kept character follows
    for ch in s.chars() {
        let mut buf = [0u8; 4];
        let piece: &str = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase().encode_utf8(&mut buf)
        } else {
            translit(ch)
        };
        if piece.is_empty() {
            gap = !out.is_empty();
            continue;
        }
        if out.len() + piece.len() + usize::from(gap) > MAX {
            break;
        }
        if gap {
            out.push('-');
            gap = false;
        }
        out.push_str(piece);
    }
    out.trim_matches('-').to_string()
}

fn djb2(s: &str) -> u32 {
    let mut h: u32 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33) ^ b as u32;
    }
    h
}

// Stable short key for a repo path, so two repos with the same folder name don't share a home.
fn path_key(root: &str) -> String {
    format!("{:08x}", djb2(&root.to_lowercase()))
}

async fn branch_exists(repo: &str, branch: &str) -> bool {
    run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .await
        .is_ok()
}

// `modelius/<slug>-<4 hex of the prompt>`, plus a directory of the same name. The hash keeps two
// chats on similar wording apart without a probing counter in the name; re-hashing with a seed
// settles the rare real clash (the same prompt twice).
async fn free_names(repo: &str, home: &Path, slug: &str, seed: &str) -> Result<(String, PathBuf), String> {
    for n in 0..100 {
        let name = format!("{slug}-{:04x}", djb2(&format!("{seed}#{n}")) & 0xffff);
        let branch = format!("modelius/{name}");
        let dir = home.join(&name);
        if !branch_exists(repo, &branch).await && !dir.exists() {
            return Ok((branch, dir));
        }
    }
    Err("too many worktrees for this name — remove some first".into())
}

// Create the isolated checkout. `base` is the ref to branch from (empty → current HEAD); `name`
// is free text the branch name is derived from — an English summary from the front end's cheap
// model, or the raw first prompt when that call didn't land.
#[tauri::command]
pub async fn git_worktree_create(
    app: tauri::AppHandle,
    cwd: String,
    base: String,
    name: String,
) -> Result<WorktreeInfo, String> {
    use tauri::Manager;
    let root = native_path(run(&cwd, &["rev-parse", "--show-toplevel"]).await?.trim());
    if root.is_empty() {
        return Err("not a git repository".into());
    }
    let base = if base.trim().is_empty() { "HEAD".to_string() } else { base.trim().to_string() };
    run(&root, &["rev-parse", "--verify", "--quiet", &base])
        .await
        .map_err(|_| format!("base ref \"{base}\" not found"))?;

    let slug = {
        let s = slugify(&name);
        if s.is_empty() { "session".to_string() } else { s }
    };
    let repo_name = root.rsplit(['/', '\\']).next().unwrap_or("repo").to_string();
    let home = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("worktrees")
        .join(format!("{}-{}", slugify(&repo_name), path_key(&root)));
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;

    let (branch, dir) = free_names(&root, &home, &slug, &name).await?;
    let path = native_path(&dir.to_string_lossy());
    run(&root, &["worktree", "add", "-b", &branch, &path, &base]).await?;
    Ok(WorktreeInfo { path, branch, base, repo: root })
}

// Everything the changes panel shows: the file list (untracked included), how far the branch is
// ahead of its base, and the diff of the checkout — working tree and all — against that base.
#[tauri::command]
pub async fn git_worktree_status(path: String, base: String) -> Result<WorktreeStatus, String> {
    let porcelain = run(&path, &["status", "--porcelain"]).await?;
    let files = porcelain
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| {
            let (status, rest) = l.split_at(2);
            // A rename reads "old -> new"; the new path is what the user cares about.
            let p = rest.trim();
            let p = p.split(" -> ").last().unwrap_or(p);
            FileChange { status: status.to_string(), path: p.trim_matches('"').to_string() }
        })
        .collect();
    let ahead = run(&path, &["rev-list", "--count", &format!("{base}..HEAD")])
        .await
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let full = run(&path, &["diff", &base]).await.unwrap_or_default();
    let truncated = full.len() > DIFF_LIMIT;
    let diff = if truncated {
        let mut cut = DIFF_LIMIT;
        while cut > 0 && !full.is_char_boundary(cut) {
            cut -= 1;
        }
        full[..cut].to_string()
    } else {
        full
    };
    Ok(WorktreeStatus { files, ahead, diff, truncated })
}

// Stage everything and commit — the agent usually leaves its edits uncommitted, and there is
// nothing to merge until they are in. Git's own error (empty commit, missing user.email) passes through.
#[tauri::command]
pub async fn git_worktree_commit(path: String, message: String) -> Result<(), String> {
    run(&path, &["add", "-A"]).await?;
    let msg = if message.trim().is_empty() { "Modelius session".to_string() } else { message };
    run(&path, &["commit", "-m", &msg]).await.map(|_| ())
}

// Merge the branch back into its base, in the main working tree. Both preconditions are checked
// up front so a half-applied merge can't be left behind; a conflicting merge is aborted.
#[tauri::command]
pub async fn git_worktree_merge(repo: String, base: String, branch: String) -> Result<(), String> {
    if !run(&repo, &["status", "--porcelain"]).await?.trim().is_empty() {
        return Err("the project folder has uncommitted changes — commit or stash them first".into());
    }
    let current = run(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?.trim().to_string();
    if current != base {
        return Err(format!("the project folder is on \"{current}\", not \"{base}\" — switch to it first"));
    }
    let msg = format!("Merge {branch}");
    match run(&repo, &["merge", "--no-ff", &branch, "-m", &msg]).await {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = run(&repo, &["merge", "--abort"]).await;
            Err(e)
        }
    }
}

// Drop the checkout. `delete_branch` also discards the work; without it the branch stays for a
// later merge or PR.
#[tauri::command]
pub async fn git_worktree_remove(
    repo: String,
    path: String,
    branch: String,
    delete_branch: bool,
) -> Result<(), String> {
    run(&repo, &["worktree", "remove", "--force", &path]).await?;
    if delete_branch {
        run(&repo, &["branch", "-D", &branch]).await?;
    }
    let _ = run(&repo, &["worktree", "prune"]).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_ascii_and_transliterates() {
        assert_eq!(slugify("Fix the auth bug"), "fix-the-auth-bug");
        assert_eq!(slugify("  add   TESTS!! "), "add-tests");
        assert_eq!(slugify("исправить баг"), "ispravit-bag");
        assert_eq!(slugify("Щи 3 ёлки"), "schi-3-elki");
        assert_eq!(slugify("修复 bug"), "bug"); // unmapped script → separator only
        assert_eq!(slugify("!!!"), "");
        assert!(slugify("Fix the auth bug").is_ascii());
        // The cap never splits a transliterated letter mid-way.
        let long = slugify(&"щ".repeat(40));
        assert!(long.len() <= 32 && long.len() % 3 == 0);
        assert!(slugify(&"a".repeat(100)).len() <= 32);
    }

    #[test]
    fn free_names_hash_is_stable_and_scoped() {
        // Same prompt → same name; different prompt → different name; slug is the readable half.
        let a = format!("{:04x}", djb2("fix auth#0") & 0xffff);
        let b = format!("{:04x}", djb2("fix auth#0") & 0xffff);
        let c = format!("{:04x}", djb2("fix auth#1") & 0xffff);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 4);
    }

    async fn sh(dir: &str, args: &[&str]) {
        run(dir, args).await.unwrap_or_else(|e| panic!("git {args:?} failed: {e}"));
    }

    fn scratch() -> std::path::PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("modelius-wt-{n}"))
    }

    // End-to-end over a throwaway repo: porcelain parsing, the commit step, both merge
    // preconditions, and cleanup. Skipped when git isn't installed.
    #[tokio::test]
    async fn worktree_roundtrip() {
        if git_bin().is_err() {
            return;
        }
        let root = scratch();
        let repo = root.join("repo");
        let wt = root.join("wt");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().to_string();
        let wt_s = wt.to_string_lossy().to_string();
        sh(&repo_s, &["init", "-b", "main"]).await;
        sh(&repo_s, &["config", "user.email", "t@example.com"]).await;
        sh(&repo_s, &["config", "user.name", "Test"]).await;
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo_s, &["add", "-A"]).await;
        sh(&repo_s, &["commit", "-m", "init"]).await;
        sh(&repo_s, &["worktree", "add", "-b", "modelius/test", &wt_s]).await;

        // Uncommitted edits in the checkout: both files listed, nothing ahead yet, diff not empty.
        std::fs::write(wt.join("a.txt"), "two\n").unwrap();
        std::fs::write(wt.join("new.txt"), "x\n").unwrap();
        let st = git_worktree_status(wt_s.clone(), "main".into()).await.unwrap();
        assert_eq!(st.files.len(), 2);
        assert!(st.files.iter().any(|f| f.status == "??" && f.path == "new.txt"));
        assert_eq!(st.ahead, 0);
        assert!(st.diff.contains("+two"));

        git_worktree_commit(wt_s.clone(), "work".into()).await.unwrap();
        let st = git_worktree_status(wt_s.clone(), "main".into()).await.unwrap();
        assert!(st.files.is_empty());
        assert_eq!(st.ahead, 1);

        // A dirty main tree blocks the merge; so does standing on another branch.
        std::fs::write(repo.join("dirty.txt"), "d\n").unwrap();
        assert!(git_worktree_merge(repo_s.clone(), "main".into(), "modelius/test".into()).await.is_err());
        std::fs::remove_file(repo.join("dirty.txt")).unwrap();
        assert!(git_worktree_merge(repo_s.clone(), "other".into(), "modelius/test".into()).await.is_err());

        git_worktree_merge(repo_s.clone(), "main".into(), "modelius/test".into()).await.unwrap();
        assert!(std::fs::read_to_string(repo.join("a.txt")).unwrap().contains("two"));
        assert!(repo.join("new.txt").exists());

        git_worktree_remove(repo_s.clone(), wt_s, "modelius/test".into(), true).await.unwrap();
        assert!(!wt.exists());
        assert!(!branch_exists(&repo_s, "modelius/test").await);

        let _ = std::fs::remove_dir_all(&root);
    }

    // The offline naming path against a real repo: a Russian prompt must yield a latin branch git
    // accepts, and the same prompt twice must not collide.
    #[tokio::test]
    async fn russian_prompt_names_a_latin_branch() {
        if git_bin().is_err() {
            return;
        }
        let root = scratch();
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().to_string();
        sh(&repo_s, &["init", "-b", "main"]).await;
        sh(&repo_s, &["config", "user.email", "t@example.com"]).await;
        sh(&repo_s, &["config", "user.name", "Test"]).await;
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo_s, &["add", "-A"]).await;
        sh(&repo_s, &["commit", "-m", "init"]).await;

        let home = root.join("worktrees");
        std::fs::create_dir_all(&home).unwrap();
        let prompt = "исправить баг авторизации";
        let (branch, dir) = free_names(&repo_s, &home, &slugify(prompt), prompt).await.unwrap();
        assert!(branch.is_ascii(), "{branch}");
        assert!(branch.starts_with("modelius/ispravit-bag-avtorizacii-"), "{branch}");
        sh(&repo_s, &["worktree", "add", "-b", &branch, &dir.to_string_lossy(), "main"]).await;
        assert!(branch_exists(&repo_s, &branch).await);
        assert!(dir.join("a.txt").exists());

        // Same prompt again: the taken name is skipped and the reseed produces another.
        let (second, _) = free_names(&repo_s, &home, &slugify(prompt), prompt).await.unwrap();
        assert_ne!(second, branch);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_key_is_stable_and_case_insensitive() {
        assert_eq!(path_key("D:\\Modelius"), path_key("d:\\modelius"));
        assert_ne!(path_key("D:\\Modelius"), path_key("D:\\Other"));
        assert_eq!(path_key("D:\\Modelius").len(), 8);
    }
}
