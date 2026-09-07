// attachments.rs — read a file the user dropped on the Code composer. The OS drag-drop that Tauri
// owns hands the webview paths, not bytes, and the fs plugin's scope doesn't cover arbitrary user
// paths — so the read happens here. Only the types a harness can carry as a content block are
// inlined (images + PDF); anything else the UI attaches by path instead, so this errors on it.
use base64::{engine::general_purpose::STANDARD, Engine};

// 32 MB — Anthropic's own per-request document ceiling; a bigger file is worth attaching by path.
const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct DroppedFile {
    pub name: String,
    pub mime: String,
    pub data: String, // base64, no data-URL prefix
}

fn inline_mime(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

#[tauri::command]
pub fn attachment_read(path: String) -> Result<DroppedFile, String> {
    let p = std::path::Path::new(&path);
    let mime = inline_mime(p).ok_or_else(|| "not an inline attachment type".to_string())?;
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("file is larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(DroppedFile {
        name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into()),
        mime: mime.to_string(),
        data: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_mime_covers_images_and_pdf_only() {
        assert_eq!(inline_mime(std::path::Path::new("a/b.PNG")), Some("image/png"));
        assert_eq!(inline_mime(std::path::Path::new("a/b.jpeg")), Some("image/jpeg"));
        assert_eq!(inline_mime(std::path::Path::new("spec.pdf")), Some("application/pdf"));
        // Everything else is attached by path, not inlined.
        assert_eq!(inline_mime(std::path::Path::new("main.rs")), None);
        assert_eq!(inline_mime(std::path::Path::new("no-extension")), None);
    }

    #[test]
    fn attachment_read_rejects_a_non_inline_type_before_touching_disk() {
        assert!(attachment_read("C:/nope/main.rs".into()).is_err());
    }
}
