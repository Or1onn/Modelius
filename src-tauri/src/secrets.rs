// secrets.rs — OS keychain access (Windows Credential Manager / macOS Keychain /
// Linux Secret Service) via the `keyring` crate. Holds API keys, OAuth tokens, the
// PKCE verifier, and the vault DEK — anything that must never touch plaintext disk.
use keyring::{Entry, Error};

pub(crate) const SERVICE: &str = "com.gracious-determined-curie.modelius";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

// Internal helpers reused by vault.rs (DEK storage).
pub(crate) fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

pub(crate) fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    set(&key, &value)
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    get(&key)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
