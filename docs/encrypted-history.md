# Encrypted history export

Settings → Maintenance offers an optional saved-history backup and recovery to a separate readable JSON file. Exports include the original transcript, personalization, correction, rewrite and record metadata. They exclude audio, model weights, runtime environments, settings, credentials and unsaved session-only results. Only the chosen export is encrypted; active app data, plaintext exports and existing backups retain their own protection.

The version-1 envelope uses Node's AES-256-GCM with a random 12-byte nonce, 16-byte authentication tag and fixed authenticated format marker. Each export uses a random 24-byte salt and asynchronous scrypt (N=16384, r=8, p=1, 32-byte key). Algorithm/version/KDF identifiers and field sizes are fixed and validated; attacker-supplied work factors are not accepted. No passphrase is persisted or logged. Passphrases are exact UTF-8 strings: do not change spaces or Unicode characters when recovering. JavaScript string copies cannot be reliably erased; keys and plaintext buffers are cleared where practical.

Recovery authenticates before parsing the plaintext schema, preserves the exact text/metadata fields, and saves only after validation. Native file dialogs choose input/output paths. Outputs are written atomically outside the active profile; no current settings or history are imported or replaced. The decrypted JSON is plaintext and must be stored accordingly. Keeping a separate recovery JSON does not establish an isolated-profile restore or restore runtime/model files. Import/migration support remains a separate workflow.

There is no password reset, server escrow or recovery key. Lost passphrases, destroyed files or corrupted authenticated data cannot be repaired by the app. Preserve a separate known-good copy and its passphrase. This workflow does not promise secure erasure or protect a compromised running desktop. Current limits: 500 records, 64 MB plaintext, supported legacy/version-1 records only.

UNVERIFIED — tests, builds, typechecks, crypto roundtrips/tampering fixtures, native dialogs/filesystem behavior and restore checks were not run per current user instruction. Do not treat this untested feature as a proven recovery backup until later verification.

API reference: [Node crypto](https://nodejs.org/download/release/v22.15.0/docs/api/crypto.html).
