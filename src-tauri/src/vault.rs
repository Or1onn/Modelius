// vault.rs — at-rest encryption (XChaCha20-Poly1305) with a 32-byte data key (DEK)
// kept in the OS keychain. Encrypts chat bodies, artifacts, and other on-disk user
// data so a stolen disk/backup yields only ciphertext. No master password: the DEK's
// confidentiality rests on the keychain.
use crate::secrets;
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use std::path::PathBuf;
use std::sync::OnceLock;

const DEK_KEY: &str = "modelius.vault.dek";
const PREFIX: &str = "v1:"; // version tag; absence = legacy plaintext
const BACKUP_PREFIX: &str = "vk1:"; // passphrase-wrapped DEK backup blob
static DEK: OnceLock<[u8; 32]> = OnceLock::new();

// App-data dir, captured at startup, for the "vault initialized" sentinel. Without it (unit
// tests) the sentinel is simply skipped, so tests behave as before.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

// Record where the sentinel lives. Called once from lib.rs setup.
pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = DATA_DIR.set(dir);
    }
}

fn sentinel_path() -> Option<PathBuf> {
    DATA_DIR.get().map(|d| d.join("vault.initialized"))
}

fn sentinel_exists() -> bool {
    sentinel_path().is_some_and(|p| p.exists())
}

// Mark this vault as initialized (idempotent). Lets dek() tell "genuine first run" from
// "the keychain lost the key" — in the latter case regenerating would orphan all ciphertext.
fn ensure_sentinel() {
    if let Some(p) = sentinel_path() {
        if !p.exists() {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&p, b"1");
        }
    }
}

// Load the DEK from the keychain, generating + persisting one on first run.
// Cached so encrypting a list of chats doesn't hit the keychain per item.
fn dek() -> Result<[u8; 32], String> {
    if let Some(k) = DEK.get() {
        return Ok(*k);
    }
    // Serialize the first-run load/generate: without this, two concurrent callers could each
    // generate a different DEK — one cached here, the other persisted to the keychain — making
    // data encrypted this session undecryptable on the next launch.
    static INIT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = INIT.lock().map_err(|e| e.to_string())?;
    if let Some(k) = DEK.get() {
        return Ok(*k);
    }
    let key: [u8; 32] = match secrets::get(DEK_KEY)? {
        Some(b64) => {
            let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
            bytes.as_slice().try_into().map_err(|_| "bad DEK length".to_string())?
        }
        None => {
            // A missing key AFTER the vault was initialized (sentinel present) means the keychain
            // lost/was reset the DEK — regenerating would silently orphan all existing ciphertext.
            // Refuse, so the user can restore from a passphrase backup instead of losing data.
            if sentinel_exists() {
                return Err("vault key missing — the encryption key is not in the keychain. Restore it from a backup to decrypt your data.".into());
            }
            let mut k = [0u8; 32];
            OsRng.fill_bytes(&mut k);
            secrets::set(DEK_KEY, &STANDARD.encode(k))?;
            k
        }
    };
    ensure_sentinel(); // record initialization for existing users too (their key was already present)
    Ok(*DEK.get_or_init(|| key))
}

// Derive a 32-byte key-encryption key from a passphrase (argon2id) for the DEK backup.
fn derive_kek(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub(crate) fn encrypt_str(plain: &str) -> Result<String, String> {
    let key = dek()?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce_bytes), plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ct);
    Ok(format!("{}{}", PREFIX, STANDARD.encode(blob)))
}

pub(crate) fn decrypt_str(blob: &str) -> Result<String, String> {
    // No version prefix → legacy plaintext written before encryption landed.
    let Some(b64) = blob.strip_prefix(PREFIX) else {
        return Ok(blob.to_string());
    };
    let key = dek()?;
    let raw = STANDARD.decode(b64).map_err(|e| e.to_string())?;
    if raw.len() < 24 {
        return Err("ciphertext too short".into());
    }
    let (nonce, ct) = raw.split_at(24);
    let pt = XChaCha20Poly1305::new(Key::from_slice(&key))
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|e| e.to_string())?;
    String::from_utf8(pt).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_encrypt(plaintext: String) -> Result<String, String> {
    encrypt_str(&plaintext)
}

#[tauri::command]
pub fn vault_decrypt(blob: String) -> Result<String, String> {
    decrypt_str(&blob)
}

// Wrap the DEK under a passphrase (argon2id KEK + XChaCha20-Poly1305). No plaintext key touches
// disk — the backup is useless without the passphrase. Layout: salt(16) ‖ nonce(24) ‖ ct.
fn wrap_dek(dek: &[u8; 32], passphrase: &str) -> Result<String, String> {
    if passphrase.is_empty() {
        return Err("passphrase required".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let kek = derive_kek(passphrase, &salt)?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = XChaCha20Poly1305::new(Key::from_slice(&kek))
        .encrypt(XNonce::from_slice(&nonce), dek.as_ref())
        .map_err(|e| e.to_string())?;
    let mut blob = Vec::with_capacity(16 + 24 + ct.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    Ok(format!("{}{}", BACKUP_PREFIX, STANDARD.encode(blob)))
}

fn unwrap_dek(blob: &str, passphrase: &str) -> Result<[u8; 32], String> {
    let b64 = blob.trim().strip_prefix(BACKUP_PREFIX).ok_or("unrecognized backup format")?;
    let raw = STANDARD.decode(b64).map_err(|e| e.to_string())?;
    if raw.len() < 16 + 24 + 16 {
        return Err("backup too short".into());
    }
    let (salt, rest) = raw.split_at(16);
    let (nonce, ct) = rest.split_at(24);
    let kek = derive_kek(passphrase, salt)?;
    let dek = XChaCha20Poly1305::new(Key::from_slice(&kek))
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| "wrong passphrase or corrupt backup".to_string())?;
    dek.as_slice().try_into().map_err(|_| "bad key length".to_string())
}

// Export a passphrase-wrapped DEK backup blob the user saves to a file.
#[tauri::command]
pub fn vault_export_key(passphrase: String) -> Result<String, String> {
    wrap_dek(&dek()?, &passphrase)
}

// Restore a passphrase-wrapped DEK into the keychain (recovery on a new machine / after a keychain
// reset). Takes effect once the process re-reads the key (relaunch if a different key was cached).
#[tauri::command]
pub fn vault_import_key(blob: String, passphrase: String) -> Result<(), String> {
    let key = unwrap_dek(&blob, &passphrase)?;
    secrets::set(DEK_KEY, &STANDARD.encode(key))?;
    ensure_sentinel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypt_str_passes_legacy_plaintext_through_unchanged() {
        // No `v1:` prefix → returns before dek(), so no keychain needed.
        assert_eq!(decrypt_str("plain legacy body").unwrap(), "plain legacy body");
        assert_eq!(decrypt_str("").unwrap(), "");
    }

    #[test]
    #[ignore = "needs the OS keychain DEK"]
    fn roundtrip_encrypts_and_decrypts() {
        let secret = "chat body with 🔑 unicode";
        let blob = encrypt_str(secret).unwrap();
        assert!(blob.starts_with("v1:"));
        assert_eq!(decrypt_str(&blob).unwrap(), secret);
    }

    #[test]
    fn dek_backup_roundtrips_under_the_passphrase() {
        let dek = [7u8; 32];
        let blob = wrap_dek(&dek, "correct horse battery staple").unwrap();
        assert!(blob.starts_with(BACKUP_PREFIX));
        assert_eq!(unwrap_dek(&blob, "correct horse battery staple").unwrap(), dek);
    }

    #[test]
    fn dek_backup_rejects_a_wrong_passphrase() {
        let blob = wrap_dek(&[9u8; 32], "right").unwrap();
        assert!(unwrap_dek(&blob, "wrong").is_err());
        assert!(unwrap_dek("vk1:not-base64!!", "right").is_err());
        assert!(unwrap_dek("no-prefix", "right").is_err());
    }
}
