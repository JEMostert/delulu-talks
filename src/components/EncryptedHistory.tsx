import { useState } from "react";
import { bridge } from "../bridge";

/** A passphrase-protected backup of the saved Logbook; decrypting never replaces it. */
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
            ? "Decrypted copy saved. Your Logbook is unchanged."
            : "Backup exported. Keep the passphrase somewhere safe.",
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
      <div className="px-6 py-4 space-y-3">
        <p className="caption">
          Saved transcripts, corrections and rewrites. Audio files and settings
          are not included.
        </p>
        <label className="field">
          Passphrase
          <input
            type="password"
            autoComplete="new-password"
            aria-label="Backup passphrase"
            maxLength={1024}
            disabled={busy}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label className="field">
          Confirm passphrase
          <input
            type="password"
            autoComplete="new-password"
            aria-label="Confirm backup passphrase"
            maxLength={1024}
            disabled={busy}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <p className="caption">
          At least 12 characters. It isn’t stored, so a lost passphrase can’t be
          recovered.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className="secondary-button"
            disabled={
              busy || passphrase.length < 12 || passphrase !== confirmation
            }
            onClick={() => void run(false)}
          >
            Export
          </button>
          <button
            className="secondary-button"
            disabled={busy || passphrase.length < 12}
            onClick={() => void run(true)}
          >
            Decrypt a backup…
          </button>
        </div>
        <p className="caption">
          Decrypting writes a readable JSON copy; it never replaces your
          Logbook.
        </p>
        {busy && <p role="status">Working…</p>}
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
