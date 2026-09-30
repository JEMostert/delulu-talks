import { useState } from "react";
import { bridge } from "../bridge";

export function EncryptedHistory() {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const run = async (recover: boolean) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const path = recover
        ? await bridge.recoverEncryptedHistory(passphrase)
        : await bridge.exportEncryptedHistory(passphrase);
      if (path)
        setMessage(
          recover
            ? "Decrypted history saved to a separate JSON file. Your active history was not changed."
            : "Encrypted history exported. Keep the passphrase separately; it cannot be recovered.",
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPassphrase("");
      setConfirmation("");
      setBusy(false);
    }
  };
  return (
    <section className="settings-group">
      <div className="group-heading">
        <h3>Encrypted history export</h3>
        <p>
          Optional backup of saved transcripts, corrections, rewrites and
          provenance. Audio files, settings, runtimes and unsaved session
          results are excluded.
        </p>
      </div>
      <div className="px-6 py-4 space-y-3">
        <label className="field">
          Passphrase
          <input
            type="password"
            autoComplete="new-password"
            aria-label="History backup passphrase"
            maxLength={1024}
            disabled={busy}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label className="field">
          Confirm for export
          <input
            type="password"
            autoComplete="new-password"
            aria-label="Confirm history backup passphrase"
            maxLength={1024}
            disabled={busy}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <p className="caption">
          Use a long unique passphrase (at least 12 characters). It is not
          saved. A lost passphrase or damaged backup cannot be recovered.
          Encryption protects this export; your active history and other copies
          remain as they were.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className="secondary-button"
            disabled={
              busy || passphrase.length < 12 || passphrase !== confirmation
            }
            onClick={() => void run(false)}
          >
            Export encrypted history
          </button>
          <button
            className="secondary-button"
            disabled={busy || passphrase.length < 12}
            onClick={() => void run(true)}
          >
            Decrypt backup to separate JSON
          </button>
        </div>
        <p className="caption">
          Recovery verifies authentication and schema before saving a readable
          JSON export outside the active profile. It never imports or replaces
          your current history. The recovered JSON is plaintext; choose where to
          keep it.
        </p>
        {busy && <p role="status">Working locally…</p>}
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
