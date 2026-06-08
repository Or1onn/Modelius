// artifacts.rs — verbatim code artifacts stored as files in the app-data dir, so
// large code blocks survive context summarization (they're stored, not paraphrased).
use tauri::Manager;

// The id is a content hash from the frontend (`code-<hex>`), so the filename can't traverse.
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
    let path = artifacts_dir(&app)?.join(format!("{id}.txt"));
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn artifact_read(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let path = artifacts_dir(&app)?.join(format!("{id}.txt"));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}
