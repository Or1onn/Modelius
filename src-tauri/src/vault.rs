// vault.rs — at-rest encryption (XChaCha20-Poly1305) with a 32-byte data key (DEK)
// kept in the OS keychain. Encrypts chat bodies, artifacts, and other on-disk user
// data so a stolen disk/backup yields only ciphertext. No master password: the DEK's
// confidentiality rests on the keychain.
use crate::secrets;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use std::sync::OnceLock;

const DEK_KEY: &str = "modelius.vault.dek";
const PREFIX: &str = "v1:"; // version tag; absence = legacy plaintext
static DEK: OnceLock<[u8; 32]> = OnceLock::new();

// Load the DEK from the keychain, generating + persisting one on first run.
// Cached so encrypting a list of chats doesn't hit the keychain per item.
fn dek() -> Result<[u8; 32], String> {
    if let Some(k) = DEK.get() {
        return Ok(*k);
    }
    let key: [u8; 32] = match secrets::get(DEK_KEY)? {
        Some(b64) => {
            let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
            bytes.as_slice().try_into().map_err(|_| "bad DEK length".to_string())?
        }
        None => {
            let mut k = [0u8; 32];
            OsRng.fill_bytes(&mut k);
            secrets::set(DEK_KEY, &STANDARD.encode(k))?;
            k
        }
    };
    Ok(*DEK.get_or_init(|| key))
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
