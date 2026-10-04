import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileAudio, LoaderCircle, Upload } from "lucide-react";
import { bridge } from "../bridge";
import { AudioSourceReview } from "../components/AudioSourceReview";
import { ImportQueue } from "../components/ImportQueue";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import { Alert } from "../components/ui";
import { MAX_AUDIO_BATCH_FILES } from "../audioFormats";
import type {
  AudioFileMetadata,
  AudioImportJob,
  TranscriptRecord,
} from "../types";

const JOB_STATES: Record<AudioImportJob["state"], [string, string]> = {
  pending: ["Queued", "neutral"],
  running: ["Transcribing", ""],
  done: ["Done", "success"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};

export function LabPage({
  history,
  busy,
  ...actions
}: TranscriptActions & { history: TranscriptRecord[]; busy: boolean }) {
  const [jobs, setJobs] = useState<AudioImportJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState<AudioImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [metadata, setMetadata] = useState<AudioFileMetadata | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const generation = useRef(0);
  const selectionBusy = useRef(false);
  async function reload() {
    const request = ++generation.current;
    try {
      const records = await bridge.getAudioJobs();
      if (request === generation.current) setJobs(records);
    } catch (reason) {
      if (request === generation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  useEffect(() => {
    if (window.delulu) void reload();
    const stop = bridge.onImportQueue(() => {
      void reload();
    });
    return () => {
      generation.current++;
      stop();
    };
  }, []);
  const file = jobs.find((job) => job.path === selected) ?? null;
  useEffect(() => {
    let alive = true;
    setMetadata(null);
    setInspecting(false);
    if (!file || file.sourceAvailable === false) return;
    setInspecting(true);
    void bridge
      .inspectAudioFile(file.path)
      .then((value) => {
        if (alive) setMetadata(value);
      })
      .catch((reason) => {
        if (alive)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setInspecting(false);
      });
    return () => {
      alive = false;
    };
  }, [file?.path, file?.sourceAvailable]);
  async function select(action: () => Promise<unknown>) {
    if (selectionBusy.current) return;
    selectionBusy.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      selectionBusy.current = false;
      setPending(false);
    }
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length) void select(() => bridge.resolveAudioFiles(files));
  }
  const result = history.find((record) => record.id === file?.resultId);
  return (
    <div className="content-stack">
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      <button
        className="file-drop"
        data-dragging={dragging}
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        disabled={pending || busy}
        onClick={() => void select(() => bridge.chooseAudioFiles())}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = pending || busy ? "none" : "copy";
        }}
        onDrop={(event) => {
          setDragging(false);
          if (!pending && !busy) drop(event);
          else event.preventDefault();
        }}
      >
        <span className="file-drop-icon" aria-hidden="true">
          {pending ? <LoaderCircle className="spin" /> : <Upload />}
        </span>
        <strong>Drop recordings here or choose files</strong>
        <small>
          Audio and video · up to {MAX_AUDIO_BATCH_FILES} files · transcribed on
          this device
        </small>
      </button>
      <ImportQueue />
      {!jobs.length && !file && (
        <p className="caption text-center">
          Results appear here and in History. Nothing leaves this device.
        </p>
      )}
      {!!jobs.length && <h3 className="lab-heading">Linked files</h3>}
      <ul className="lab-files" aria-label="Linked source files">
        {jobs.map((job) => (
          <li
            key={job.path}
            className={`lab-file ${selected === job.path ? "selected" : ""}`}
          >
            <button
              className="lab-file-select"
              aria-pressed={selected === job.path}
              onClick={() => setSelected(job.path)}
            >
              <FileAudio aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <strong>{job.name}</strong>
                <small>{(job.size / 1048576).toFixed(1)} MiB</small>
              </span>
              <span className={`badge ${JOB_STATES[job.state][1]}`}>
                {JOB_STATES[job.state][0]}
              </span>
            </button>
            {job.sourceError && (
              <p className="field-error">{job.sourceError}</p>
            )}
            {job.error && <p className="field-error">{job.error}</p>}
            <div className="panel-actions">
              <button
                className="tool-button compact"
                disabled={job.sourceAvailable === false}
                onClick={() => setReview(job)}
              >
                Review linked audio
              </button>
              {job.sourceAvailable === false && (
                <button
                  className="tool-button compact"
                  disabled={pending || busy}
                  onClick={() =>
                    void select(() => bridge.relinkAudioJob(job.path))
                  }
                >
                  Relink source…
                </button>
              )}
              <button
                className="tool-button compact"
                disabled={pending || busy}
                onClick={() =>
                  void select(() => bridge.removeAudioJob(job.path))
                }
              >
                Remove from list
              </button>
            </div>
          </li>
        ))}
      </ul>
      {file && (
        <section className="lab-detail" aria-live="polite">
          <h3>{file.name}</h3>
          {inspecting ? (
            <p className="caption">Inspecting media…</p>
          ) : metadata ? (
            <>
              <p className="caption">
                {metadata.durationSeconds === null
                  ? "Duration unknown"
                  : `${metadata.durationSeconds.toFixed(1)} seconds`}{" "}
                · {metadata.channels ?? "unknown"} channels ·{" "}
                {metadata.sampleRate ?? "unknown"} Hz
              </p>
              <p className="caption">{metadata.decoderDetail}</p>
              <p className="caption">{metadata.processingTimeEstimate}</p>
              {metadata.estimatedPcmBytes !== null && (
                <p>
                  Estimated mono 16 kHz PCM:{" "}
                  {(metadata.estimatedPcmBytes / 1048576).toFixed(1)} MiB
                </p>
              )}
            </>
          ) : (
            <p>
              Media metadata unavailable. Duration and decoder readiness remain
              unknown.
            </p>
          )}
          {result ? (
            <TranscriptCard record={result} {...actions} />
          ) : (
            file.resultId && (
              <p>
                The referenced transcript is no longer retained. Source media
                has not been deleted.
              </p>
            )
          )}
        </section>
      )}
      {review && (
        <AudioSourceReview
          key={review.path}
          path={review.path}
          name={review.name}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}
