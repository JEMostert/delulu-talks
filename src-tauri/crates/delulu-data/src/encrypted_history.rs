//! Passphrase-encrypted history export (`encryptedHistory.ts`).
//!
//! Container: a JSON object `{format, version, kdf, cipher, salt, iv, tag,
//! ciphertext}` (base64 fields). Key: scrypt N=16384 r=8 p=1, 32 bytes, from
//! a 24-byte salt. Cipher: AES-256-GCM with a 12-byte IV, 16-byte tag and the
//! fixed AAD below. Files exported by the Electron app decrypt unchanged.
//!
//! Both functions are CPU-bound (scrypt); call them from a blocking task.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use delulu_core::util::utf16_len;
use delulu_core::{DomainError, DomainResult};
use rand::RngCore;
use regex::Regex;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::{json as js, plain_error, time};

const FORMAT: &str = "delulu-encrypted-history";
const EXPORT_FORMAT: &str = "delulu-history-export";
const MAX_BYTES: usize = 64 * 1024 * 1024;
const AAD: &[u8] = b"delulu-encrypted-history:1:scrypt-16384-8-1:aes-256-gcm";

fn password(value: &Value) -> DomainResult<&str> {
    match value {
        Value::String(text) if utf16_len(text) >= 12 && text.len() <= 1024 => Ok(text),
        _ => Err(plain_error("Use a passphrase of at least 12 characters and at most 1,024 UTF-8 bytes.")),
    }
}

fn key_for(passphrase: &str, salt: &[u8]) -> DomainResult<Zeroizing<[u8; 32]>> {
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|error| plain_error(error.to_string()))?;
    let mut key = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, key.as_mut()).map_err(|error| plain_error(error.to_string()))?;
    Ok(key)
}

fn invalid_record() -> DomainError {
    plain_error("Backup contains an invalid or unsupported transcript record.")
}

fn valid_records(value: Option<&Value>) -> DomainResult<Vec<Value>> {
    let records = match value {
        Some(Value::Array(records)) if records.len() <= 500 => records,
        _ => return Err(plain_error("Backup must contain at most 500 saved history records.")),
    };
    let mut ids = std::collections::HashSet::new();
    for record in records {
        let Value::Object(map) = record else { return Err(invalid_record()) };
        let text = |key: &str| map.get(key).and_then(Value::as_str);
        let number = |key: &str| map.get(key).and_then(Value::as_f64);
        let id = text("id").unwrap_or_default();
        let valid = !id.is_empty()
            && utf16_len(id) <= 128
            && !ids.contains(id)
            && text("text").is_some_and(|t| utf16_len(t) <= 500_000)
            && number("createdAt").is_some()
            && number("durationMs").is_some_and(|d| d >= 0.0)
            && text("model").is_some()
            && text("language").is_some()
            && matches!(text("source"), Some("dictation" | "file"))
            && map.get("schemaVersion").is_none_or(|v| v.as_f64() == Some(1.0));
        if !valid {
            return Err(invalid_record());
        }
        for name in ["editedText", "personalizedText", "magicText"] {
            match map.get(name) {
                None | Some(Value::Null) => {}
                Some(Value::String(t)) if utf16_len(t) <= 500_000 => {}
                _ => return Err(plain_error("Backup contains an invalid text variant.")),
            }
        }
        ids.insert(id.to_owned());
    }
    Ok(records.clone())
}

fn plain_history(value: &Value) -> DomainResult<Value> {
    let Some(map) = value.as_object() else { return Err(plain_error("Unsupported history backup schema.")) };
    let created = map.get("createdAt").and_then(Value::as_str);
    if map.get("format").and_then(Value::as_str) != Some(EXPORT_FORMAT)
        || map.get("version").and_then(Value::as_f64) != Some(1.0)
        || created.and_then(time::parse_iso).is_none()
    {
        return Err(plain_error("Unsupported history backup schema."));
    }
    Ok(json!({
        "format": EXPORT_FORMAT,
        "version": 1,
        "createdAt": created,
        "records": valid_records(map.get("records"))?,
    }))
}

fn base64_pattern() -> &'static Regex {
    static RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$").expect("valid regex")
    });
    &RE
}

fn bytes(value: Option<&Value>, expected: Option<usize>) -> DomainResult<Vec<u8>> {
    let encoding = || plain_error("Invalid backup encoding.");
    let text = value.and_then(Value::as_str).ok_or_else(encoding)?;
    if text.len() > MAX_BYTES.div_ceil(3) * 4 || !base64_pattern().is_match(text) {
        return Err(encoding());
    }
    let decoded = STANDARD.decode(text).map_err(|_| encoding())?;
    if expected.is_some_and(|n| decoded.len() != n) || decoded.len() > MAX_BYTES {
        return Err(plain_error("Invalid backup field size."));
    }
    Ok(decoded)
}

/// Encrypts saved history records (as persisted JSON) into a `.delulubak` text.
pub fn encrypt_history(records: &[Value], passphrase: &Value) -> DomainResult<String> {
    let secret = password(passphrase)?;
    let history = plain_history(&json!({
        "format": EXPORT_FORMAT,
        "version": 1,
        "createdAt": time::now_iso(),
        "records": records,
    }))?;
    let payload = Zeroizing::new(js::stringify(&history).into_bytes());
    if payload.len() > MAX_BYTES {
        return Err(plain_error("History exceeds the 64 MB encrypted-export limit."));
    }
    let mut salt = [0u8; 24];
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut iv);
    let key = key_for(secret, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|error| plain_error(error.to_string()))?;
    let mut sealed = cipher
        .encrypt(Nonce::from_slice(&iv), Payload { msg: &payload, aad: AAD })
        .map_err(|_| plain_error("History could not be encrypted."))?;
    let tag = sealed.split_off(sealed.len() - 16);
    Ok(js::stringify(&json!({
        "format": FORMAT,
        "version": 1,
        "kdf": "scrypt-16384-8-1",
        "cipher": "aes-256-gcm",
        "salt": STANDARD.encode(salt),
        "iv": STANDARD.encode(iv),
        "tag": STANDARD.encode(tag),
        "ciphertext": STANDARD.encode(sealed),
    })))
}

/// Decrypts a `.delulubak` text to the pretty-printed plain history export.
pub fn decrypt_history(encoded: &str, passphrase: &Value) -> DomainResult<String> {
    let secret = password(passphrase)?;
    if encoded.len() as f64 > MAX_BYTES as f64 * 1.4 {
        return Err(plain_error("Encrypted backup exceeds the supported size."));
    }
    let envelope: Value = serde_json::from_str(encoded).map_err(DomainError::from)?;
    let field = |key: &str| envelope.get(key).and_then(Value::as_str);
    if !envelope.is_object()
        || field("format") != Some(FORMAT)
        || envelope.get("version").and_then(Value::as_f64) != Some(1.0)
        || field("kdf") != Some("scrypt-16384-8-1")
        || field("cipher") != Some("aes-256-gcm")
    {
        return Err(plain_error("Unsupported encrypted backup format or version."));
    }
    let salt = bytes(envelope.get("salt"), Some(24))?;
    let iv = bytes(envelope.get("iv"), Some(12))?;
    let tag = bytes(envelope.get("tag"), Some(16))?;
    let mut sealed = bytes(envelope.get("ciphertext"), None)?;
    sealed.extend_from_slice(&tag);
    let key = key_for(secret, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|error| plain_error(error.to_string()))?;
    let plaintext = Zeroizing::new(cipher.decrypt(Nonce::from_slice(&iv), Payload { msg: &sealed, aad: AAD }).map_err(
        |_| plain_error("The passphrase is incorrect or the encrypted backup was changed. Nothing was restored."),
    )?);
    let parsed: Value = serde_json::from_slice(&plaintext).map_err(DomainError::from)?;
    let history = plain_history(&parsed)?;
    Ok(js::profile_bytes(&history))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records() -> Vec<Value> {
        vec![json!({"id": "a", "createdAt": 1, "durationMs": 0, "text": "Private 🎙️", "model": "r2t2",
            "language": "en", "source": "dictation", "editedText": null, "extension": {"kept": true}})]
    }

    #[test]
    fn round_trip_and_wrong_passphrase() {
        let passphrase = json!("correct horse battery");
        let encoded = encrypt_history(&records(), &passphrase).unwrap();
        let decrypted: Value = serde_json::from_str(&decrypt_history(&encoded, &passphrase).unwrap()).unwrap();
        assert_eq!(decrypted["records"], Value::Array(records()));
        let error = decrypt_history(&encoded, &json!("incorrect horse battery")).unwrap_err();
        assert!(error.message.starts_with("The passphrase is incorrect"));
        assert!(encrypt_history(&records(), &json!("short")).is_err());
    }

    #[test]
    fn decrypts_a_backup_exported_by_the_electron_app() {
        let encoded = include_str!("../tests/fixtures/electron-history.delulubak");
        let expected = include_str!("../tests/fixtures/electron-history.decrypted.json");
        let decrypted = decrypt_history(encoded.trim(), &json!("correct horse battery")).unwrap();
        assert_eq!(decrypted, expected);
    }
}
