import { useEffect, useRef, useState } from "react";
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
import { formatClock } from "../statusLabels";
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

/** "2:05 · Stereo · 48 kHz", leaving out what inspection could not tell. */
function mediaSummary(media: AudioFileMetadata) {
  const channels =
    media.channels === 1
      ? "Mono"
      : media.channels === 2
        ? "Stereo"
        : media.channels && `${media.channels} channels`;
  return [
    media.durationSeconds === null
      ? "Length unknown"
      : formatClock(media.durationSeconds * 1000),
    channels,
    media.sampleRate && `${media.sampleRate / 1000} kHz`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Bottles: imported recordings, their queue and their transcripts. */
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
  // Native drag-and-drop delivers local paths while this page is visible;
  // hidden Activity pages release their effects, so drops target Lab only.
  const dropBlocked = useRef(false);
  dropBlocked.current = pending || busy;
  useEffect(
    () =>
      bridge.onFilesDropped((paths) => {
        setDragging(false);
        if (!dropBlocked.current && paths.length)
          void select(() => bridge.resolveAudioPaths(paths));
      }),
    [],
  );
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
          // The desktop reports dropped paths through onFilesDropped.
          event.preventDefault();
          setDragging(false);
        }}
      >
        <span className="file-drop-icon" aria-hidden="true">
          {pending ? <LoaderCircle className="spin" /> : <Upload />}
        </span>
        <strong>Drop audio or video</strong>
        <small>or click to choose · up to {MAX_AUDIO_BATCH_FILES} files</small>
      </button>
      <ImportQueue />
      {!!jobs.length && <h3 className="lab-heading">Files</h3>}
      <ul className="lab-files" aria-label="Files">
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
                aria-label={`Listen to ${job.name}`}
                disabled={job.sourceAvailable === false}
                onClick={() => setReview(job)}
              >
                Listen
              </button>
              {job.sourceAvailable === false && (
                <button
                  className="tool-button compact"
                  aria-label={`Relink ${job.name}`}
                  disabled={pending || busy}
                  onClick={() =>
                    void select(() => bridge.relinkAudioJob(job.path))
                  }
                >
                  Relink…
                </button>
              )}
              <button
                className="tool-button compact"
                aria-label={`Remove ${job.name} from the list`}
                disabled={pending || busy}
                onClick={() =>
                  void select(() => bridge.removeAudioJob(job.path))
                }
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      {file && (
        <section className="lab-detail" aria-live="polite">
          <h3>{file.name}</h3>
          <p className="caption">
            {inspecting
              ? "Inspecting…"
              : metadata
                ? mediaSummary(metadata)
                : "Details unavailable"}
          </p>
          {metadata && !metadata.decoderReady && (
            <p className="caption">{metadata.decoderDetail}</p>
          )}
          {result ? (
            <TranscriptCard record={result} {...actions} />
          ) : (
            file.resultId && (
              <p className="caption">Transcript no longer in the Logbook.</p>
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
