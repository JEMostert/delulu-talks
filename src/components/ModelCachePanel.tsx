import { useRef, useState } from "react";
import { HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { bridge } from "../bridge";
import type { DictationStatus, MagicStatus, ModelCachePreview } from "../types";
import { Alert, Modal } from "./ui";

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function ModelCachePanel({ status, magicStatus, busy }: {
  status: DictationStatus;
  magicStatus: MagicStatus;
  busy: boolean;
}) {
  const [preview, setPreview] = useState<ModelCachePreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const operation = useRef(false);
  const unloaded = ["unloaded", "missing"].includes(status.engine) &&
    ["unloaded", "missing"].includes(magicStatus.engine);
  const blocked = busy || !unloaded || status.phase === "listening" ||
    ["preparing", "loading", "transcribing"].includes(status.phase) ||
    ["preparing", "loading", "rewriting"].includes(magicStatus.phase);
  const entries = preview?.entries.filter((entry) => selected.includes(entry.id)) ?? [];
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const complete = entries.every((entry) => entry.sizeComplete);

  async function refresh() {
    if (operation.current) return;
    operation.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    setPreview(null);
    setSelected([]);
    try {
      setPreview(await bridge.previewModelCache());
    } catch (reason) {
      setError(String(reason));
    } finally {
      operation.current = false;
      setWorking(false);
    }
  }

  async function unload() {
    if (operation.current || busy) return;
    operation.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await bridge.unloadModel();
      await bridge.unloadMagic();
      setMessage("Unload requested for both engines. Cleanup is available once both report unloaded.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      operation.current = false;
      setWorking(false);
    }
  }

  async function cleanup() {
    if (operation.current || blocked || !preview || entries.length === 0) return;
    operation.current = true;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const result = await bridge.cleanupModelCache(preview.token, selected);
      setMessage(`Deleted ${result.deletedIds.length} cache ${result.deletedIds.length === 1 ? "entry" : "entries"}. Preview again before another cleanup.`);
      if (result.failures.length)
        setError(result.failures.map((failure) => `${failure.id}: ${failure.message}`).join("\n"));
      setPreview(null);
      setSelected([]);
      setConfirming(false);
    } catch (reason) {
      setError(String(reason));
      setConfirming(false);
    } finally {
      operation.current = false;
      setWorking(false);
    }
  }

  return (
    <section className="card" aria-labelledby="model-cache-heading">
      <div className="section-heading">
        <div>
          <span className="eyebrow">LOCAL STORAGE</span>
          <h3 id="model-cache-heading">Clean up cached models</h3>
        </div>
        <HardDrive className="h-5 w-5 text-accent-ink" />
      </div>
      <p className="mt-3 text-sm text-muted">
        Preview downloaded model folders before choosing what to delete. Removed weights
        must be downloaded again when needed. Transcripts, settings and Python environments
        are kept.
      </p>
      <div className="runtime-actions mt-4">
        <button className="secondary-button" disabled={working} onClick={() => void refresh()}>
          <RefreshCw className={working ? "spin" : ""} /> Preview cache
        </button>
        {!unloaded && (
          <button className="secondary-button" disabled={working || busy} onClick={() => void unload()}>
            Unload speech and rewriting
          </button>
        )}
      </div>
      {blocked && (
        <p className="mt-3 text-xs text-muted">
          Finish recording or model operations, then explicitly unload both engines before
          deleting anything. An engine error also requires an explicit unload.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {message && <p className="mt-3 text-sm" role="status">{message}</p>}
      {preview && (
        <>
          {preview.entries.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No removable cache entries were found.</p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {preview.entries.map((entry) => (
                <label key={entry.id} className="flex items-start gap-3 rounded-lg border border-line p-3">
                  <input type="checkbox" className="mt-1" checked={selected.includes(entry.id)}
                    disabled={working || confirming}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, entry.id] : current.filter((id) => id !== entry.id))} />
                  <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                    {entry.label}
                    <small className="mt-1 block text-muted">
                      {entry.sizeComplete ? "" : "At least "}{sizeLabel(entry.bytes)}
                      {!entry.sizeComplete && " · size scan incomplete"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            Sizes count local files without following symbolic links. A preview expires after ten minutes.
          </p>
          <button className="danger-button mt-4" disabled={working || blocked || entries.length === 0}
            onClick={() => setConfirming(true)}>
            <Trash2 /> Delete selected cache…
          </button>
        </>
      )}
      {confirming && (
        <Modal title="Delete selected model cache?" busy={working} onClose={() => setConfirming(false)}
          footer={<>
            <button className="secondary-button" autoFocus disabled={working} onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger-button" disabled={working || blocked} onClick={() => void cleanup()}>
              {working ? "Deleting…" : "Delete cached files"}
            </button>
          </>}>
          <p>This permanently deletes {entries.length} selected cache {entries.length === 1 ? "entry" : "entries"}
            {complete ? " totalling " : " containing at least "}{sizeLabel(bytes)}. Downloads will be required again.</p>
          <ul className="mt-3 list-disc pl-5 text-sm [overflow-wrap:anywhere]">
            {entries.map((entry) => <li key={entry.id}>{entry.label}</li>)}
          </ul>
          {blocked && <p className="mt-3 text-sm">Cleanup is blocked until both engines are unloaded and idle.</p>}
        </Modal>
      )}
    </section>
  );
}
