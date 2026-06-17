// artifacts.rs — verbatim code artifacts stored as encrypted files in the app-data
// dir, so large code blocks survive context summarization (they're stored, not
// paraphrased) without leaving plaintext code on disk.
use crate::vault;
use tauri::Manager;

// The id is a djb2 content hash from the frontend (`code-<8 hex>`). Validate it so a
// crafted id can't traverse out of the artifacts dir (the only caller is trusted, but
// the command is reachable — defense in depth).
fn valid_id(id: &str) -> bool {
    id.strip_prefix("code-")
        .is_some_and(|h| h.len() == 8 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn artifacts_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("artifacts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn artifact_write(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("invalid artifact id".into());
    }
    let path = artifacts_dir(&app)?.join(format!("{id}.txt"));
    let blob = vault::encrypt_str(&content)?;
    std::fs::write(path, blob).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn artifact_read(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err("invalid artifact id".into());
    }
    let path = artifacts_dir(&app)?.join(format!("{id}.txt"));
    if !path.exists() {
        return Ok(None);
    }
    let blob = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    vault::decrypt_str(&blob).map(Some)
}
