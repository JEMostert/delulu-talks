import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileAudio, LoaderCircle, Upload } from "lucide-react";
import { bridge } from "../bridge";
import { AudioSourceReview } from "./AudioSourceReview";
import { Alert } from "./ui";
import {
  emptyImportQueue,
  type ImportJobState,
  type ImportQueueJob,
  type ImportQueueSnapshot,
} from "../importQueue";
import { formatClock } from "../statusLabels";
import type {
  AudioFileMetadata,
  AudioFileSelection,
  AudioImportJob,
} from "../types";

const STATES: Record<ImportJobState, [string, string]> = {
  queued: ["Queued", "neutral"],
  running: ["Transcribing", ""],
  cancelling: ["Cancelling…", "neutral"],
  completed: ["Done", "success"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const working = (job: ImportQueueJob) =>
  job.state === "running" || job.state === "cancelling";
const stopped = (job: ImportQueueJob) =>
  job.state === "failed" || job.state === "cancelled";
const mebibytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

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

export type FileImports = ReturnType<typeof useFileImports>;

/**
 * Audio and video imports for History: the queue, its durable jobs, the
 * file chooser and native drops. Drops only arrive while History is visible,
 * because hidden Activity pages release their effects.
 */
export function useFileImports(busy: boolean, onAdded: () => void) {
  const [queue, setQueue] = useState(emptyImportQueue);
  const [jobs, setJobs] = useState<AudioImportJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const submitting = useRef(false);
  const generation = useRef(0);
  const depth = useRef(0);

  function accept(snapshot: ImportQueueSnapshot) {
    setQueue((current) =>
      snapshot.version >= current.version ? snapshot : current,
    );
  }
  // Durable jobs add source availability and register paths for review.
  async function reload() {
    if (!window.delulu) return;
    const request = ++generation.current;
    try {
      const records = await bridge.getAudioJobs();
      if (request === generation.current) setJobs(records);
    } catch (reason) {
      if (request === generation.current) setError(message(reason));
    }
  }
  useEffect(() => {
    const stop = bridge.onImportQueue((snapshot) => {
      accept(snapshot);
      void reload();
    });
    void bridge
      .getImportQueue()
      .then(accept)
      .catch((reason: unknown) => setError(message(reason)));
    void reload();
    return () => {
      generation.current++;
      stop();
    };
  }, []);

  const running = queue.jobs.some(working);
  // The desktop refuses new files while anything transcribes.
  const blocked = running
    ? "Wait for the current file to finish"
    : busy
      ? "Wait for the current task to finish"
      : null;

  async function run(action: () => Promise<unknown>) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      submitting.current = false;
      setPending(false);
      void reload();
    }
  }
  const resume = async () => accept(await bridge.pauseImportQueue(false));

  // Completed jobs are History records already. Pruning them keeps the queue
  // limit for open work; failed and cancelled files keep their error.
  async function pruneCompleted() {
    const snapshot = await bridge.getImportQueue();
    const done = snapshot.jobs.filter((job) => job.state === "completed");
    if (!done.length) return;
    if (!snapshot.jobs.some(stopped))
      accept(await bridge.clearFinishedImports());
    else for (const job of done) await bridge.removeAudioJob(job.path);
  }
  const add = (pick: () => Promise<AudioFileSelection[]>) =>
    run(async () => {
      await pruneCompleted();
      if (!(await pick()).length) return;
      // Adding files pauses the queue; start it so they transcribe right away.
      await resume();
      onAdded();
    });

  const latest = useRef({ add, blocked });
  latest.current = { add, blocked };
  useEffect(
    () =>
      bridge.onFilesDropped((paths) => {
        depth.current = 0;
        setDragging(false);
        const { add, blocked } = latest.current;
        if (blocked) setError(`${blocked}, then drop the files again.`);
        else void add(() => bridge.resolveAudioPaths(paths));
      }),
    [],
  );

  const sources = new Map(jobs.map((job) => [job.path, job]));
  const files = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");
  return {
    rows: queue.jobs
      .filter((job) => job.state !== "completed")
      .map((job) => ({ ...job, source: sources.get(job.path) })),
    paused: queue.paused,
    running,
    blocked,
    pending,
    error,
    dragging,
    dismissError: () => setError(null),
    sourceFor: (recordId: string) =>
      jobs.find((job) => job.resultId === recordId) ?? null,
    choose: () => {
      if (!blocked) void add(() => bridge.chooseAudioFiles());
    },
    cancel: (job: ImportQueueJob) =>
      run(async () => accept(await bridge.cancelImportJob(job.id))),
    retry: (job: ImportQueueJob) =>
      run(async () => {
        await bridge.retryImportJob(job.id);
        await resume();
      }),
    relink: (job: ImportQueueJob) =>
      run(async () => {
        if (await bridge.relinkAudioJob(job.path)) await resume();
      }),
    remove: (job: ImportQueueJob) => run(() => bridge.removeAudioJob(job.path)),
    resume: () => run(resume),
    clearStopped: () =>
      run(async () => accept(await bridge.clearFinishedImports())),
    dropTarget: {
      onDragEnter(event: DragEvent) {
        if (!files(event)) return;
        depth.current++;
        setDragging(true);
      },
      onDragOver(event: DragEvent) {
        if (!files(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = blocked || pending ? "none" : "copy";
      },
      onDragLeave(event: DragEvent) {
        if (!files(event) || --depth.current > 0) return;
        depth.current = 0;
        setDragging(false);
      },
      onDrop(event: DragEvent) {
        // The desktop reports dropped paths through onFilesDropped.
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
      },
    },
  };
}

/** Covers the page while files are dragged over it. */
export function FileDropOverlay({ imports }: { imports: FileImports }) {
  if (!imports.dragging) return null;
  return (
    <div
      className="file-drop-overlay"
      data-blocked={!!imports.blocked}
      aria-hidden="true"
    >
      <Upload />
      <strong>{imports.blocked ?? "Drop audio or video to transcribe"}</strong>
    </div>
  );
}

/**
 * Files on their way to History, one row each with only the actions that
 * apply. Finished files leave the list as their transcripts arrive.
 */
export function FileImportList({ imports }: { imports: FileImports }) {
  const { rows, pending, blocked } = imports;
  if (!rows.length && !imports.error) return null;
  const stalled =
    imports.paused &&
    !imports.running &&
    rows.some((job) => job.state === "queued");
  return (
    <section
      className="file-imports"
      aria-label="Files to transcribe"
      aria-busy={pending}
    >
      {imports.error && (
        <Alert onDismiss={imports.dismissError}>{imports.error}</Alert>
      )}
      {!!rows.length && (
        <div className="file-imports-head">
          <h3>Files</h3>
          {stalled && <span>Paused</span>}
          <span className="flex-1" />
          {stalled && (
            <button
              className="text-button compact"
              aria-label="Resume transcribing files"
              disabled={pending}
              onClick={() => void imports.resume()}
            >
              Resume
            </button>
          )}
          {rows.filter(stopped).length > 1 && (
            <button
              className="text-button compact"
              aria-label="Remove failed and cancelled files from the list"
              disabled={pending}
              onClick={() => void imports.clearStopped()}
            >
              Clear failed
            </button>
          )}
        </div>
      )}
      <ol aria-label="Files" aria-live="polite">
        {rows.map((job) => {
          const [label, tone] = STATES[job.state];
          const missing = job.source?.sourceAvailable === false;
          const detail = missing ? job.source?.sourceError : job.error;
          return (
            <li key={job.id} className="file-import">
              <div className="file-import-top">
                <FileAudio aria-hidden="true" />
                <span className="file-import-name" title={job.name}>
                  {job.name}
                </span>
                <span className={`badge ${tone}`}>
                  {job.state === "running" && (
                    <LoaderCircle className="spin" aria-hidden="true" />
                  )}
                  {label}
                </span>
              </div>
              {detail && <p className="field-error">{detail}</p>}
              <div className="file-import-actions">
                {(job.state === "queued" || job.state === "running") && (
                  <button
                    className="text-button compact"
                    aria-label={`Cancel ${job.name}`}
                    disabled={pending}
                    onClick={() => void imports.cancel(job)}
                  >
                    Cancel
                  </button>
                )}
                {stopped(job) && !missing && (
                  <button
                    className="text-button compact"
                    aria-label={`Retry ${job.name}`}
                    disabled={pending}
                    onClick={() => void imports.retry(job)}
                  >
                    Retry
                  </button>
                )}
                {missing && !working(job) && (
                  <button
                    className="text-button compact"
                    aria-label={`Relink ${job.name}`}
                    title={blocked ?? undefined}
                    disabled={pending || !!blocked}
                    onClick={() => void imports.relink(job)}
                  >
                    Relink…
                  </button>
                )}
                {(stopped(job) || missing) && !working(job) && (
                  <button
                    className="text-button compact"
                    aria-label={`Remove ${job.name} from the list`}
                    title={blocked ?? undefined}
                    disabled={pending || !!blocked}
                    onClick={() => void imports.remove(job)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const inspected = new Map<string, AudioFileMetadata>();

/** The source of a file transcript, with its length and a player. */
export function FileSource({ job }: { job: AudioImportJob }) {
  const missing = job.sourceAvailable === false;
  const [media, setMedia] = useState(() => inspected.get(job.path) ?? null);
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (missing || inspected.has(job.path)) return;
    let alive = true;
    // Details are optional; the file size stands in when inspection fails.
    void bridge
      .inspectAudioFile(job.path)
      .then((value) => {
        inspected.set(job.path, value);
        if (alive) setMedia(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [job.path, missing]);
  return (
    <section className="history-source" aria-label="Source file">
      <div className="history-source-row">
        <FileAudio aria-hidden="true" />
        <span className="history-source-text">
          <strong title={job.name}>{job.name}</strong>
          <small>
            {missing
              ? (job.sourceError ?? "Source file not found")
              : media
                ? mediaSummary(media)
                : mebibytes(job.size)}
          </small>
        </span>
        <button
          className="tool-button compact"
          aria-label={`Listen to ${job.name}`}
          aria-expanded={listening}
          disabled={missing}
          onClick={() => setListening(!listening)}
        >
          Listen
        </button>
      </div>
      {listening && (
        <AudioSourceReview
          path={job.path}
          name={job.name}
          onClose={() => setListening(false)}
        />
      )}
    </section>
  );
}
