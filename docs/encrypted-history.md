# Encrypted history export

Settings → Privacy → Encrypted backup saves your Logbook to a passphrase-encrypted `.delulubak` file and can turn such a file back into a readable JSON file. Exports include the original transcript, personalization, correction, rewrite and record metadata. They exclude audio, model weights, runtime environments, settings, credentials and unsaved session-only results. Only the chosen export is encrypted; active app data and plaintext exports keep their own protection.

The implementation is `src-tauri/crates/delulu-data/src/encrypted_history.rs`. The version-1 container is a JSON object with base64 fields. The key comes from scrypt (N=16384, r=8, p=1, 32-byte key) over a random 24-byte salt per export. Encryption is AES-256-GCM with a random 12-byte nonce, a 16-byte authentication tag and a fixed associated-data string that binds the format, version, KDF and cipher. These identifiers and field sizes are fixed and validated; work factors from a file are never accepted. No passphrase is persisted or logged, and the key and decrypted plaintext are held in buffers that are zeroed when dropped. Passphrases are exact UTF-8 strings: do not change spaces or Unicode characters when recovering. Backups exported by the earlier Electron releases decrypt unchanged.

Recovery authenticates before parsing the plaintext, preserves the exact text and metadata fields, and saves only after validation. Native file dialogs choose input and output paths. The recovered JSON is written outside the active profile; no current settings or history are imported or replaced. The decrypted JSON is plaintext and must be stored accordingly.

There is no password reset, server escrow or recovery key. Lost passphrases, destroyed files or corrupted authenticated data cannot be repaired by the app. Keep a separate known-good copy and its passphrase. This workflow does not promise secure erasure or protect a compromised running desktop. Limits: 500 records and 64 MB of plaintext.

`cargo test -p delulu-data encrypted_history` checks a round trip, a wrong passphrase and decryption of a backup exported by the Electron app.
