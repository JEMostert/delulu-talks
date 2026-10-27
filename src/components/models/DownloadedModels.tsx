import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { bridge } from "../../bridge";
import type { DictationStatus, SpeechDownload } from "../../types";
import { ConfirmDialog } from "../ui";

function sizeLabel(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Downloaded speech models with their size, each deletable on its own. */
export function DownloadedModels({
  status,
  busy,
}: {
  status: DictationStatus;
  busy: boolean;
}) {
  const [downloads, setDownloads] = useState<SpeechDownload[]>([]);
  const [confirm, setConfirm] = useState<SpeechDownload | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  // Setup and loading can download a model; list again when they settle.
  useEffect(() => {
    let current = true;
    bridge
      .listSpeechDownloads()
      .then((items) => current && setDownloads(items))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [status.engine, status.model]);
  const working = [
    "preparing",
    "loading",
    "transcribing",
    "listening",
  ].includes(status.phase);
  const remove = async (download: SpeechDownload) => {
    setDeleting(true);
    setError("");
    try {
      setDownloads(await bridge.deleteSpeechDownload(download.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(false);
    }
  };
  if (!downloads.length) return null;
  return (
    <div className="downloaded-models">
      <h3>Downloaded</h3>
      <ul>
        {downloads.map((download) => (
          <li key={download.id}>
            <span>{download.name}</span>
            <span className="text-muted">{sizeLabel(download.bytes)}</span>
            <button
              className="tool-button"
              disabled={busy || working || deleting}
              aria-label={`Delete ${download.name}`}
              onClick={() => setConfirm(download)}
            >
              <Trash2 /> Delete
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete ${confirm.name}?`}
          confirmLabel={`Delete ${sizeLabel(confirm.bytes)}`}
          onConfirm={() => void remove(confirm)}
          onClose={() => setConfirm(null)}
        >
          <p>
            It downloads again if you use it later. Your Logbook and settings
            stay.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
