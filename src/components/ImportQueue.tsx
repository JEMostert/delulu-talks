import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pause, Play, RotateCcw, X } from "lucide-react";
import { bridge } from "../bridge";
import {
  emptyImportQueue,
  IMPORT_QUEUE_LIMIT,
  type ImportQueueSnapshot,
} from "../importQueue";

export function ImportQueue() {
  const [queue, setQueue] = useState(emptyImportQueue);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);

  function accept(snapshot: ImportQueueSnapshot) {
    if (!mounted.current) return;
    setQueue((current) =>
      snapshot.version >= current.version ? snapshot : current,
    );
    setReady(true);
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bridge.onImportQueue(accept);
    void bridge
      .getImportQueue()
      .then(accept)
      .catch((reason: unknown) => {
        if (mounted.current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load the import queue.",
          );
      });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, []);

  async function command(action: () => Promise<ImportQueueSnapshot>) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      accept(await action());
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The queue could not be updated.",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const disabled = pending || !ready;
  const queued = queue.jobs.filter((job) => job.state === "queued");
  const finished = queue.jobs.some((job) =>
    ["completed", "failed", "cancelled"].includes(job.state),
  );
  const active = queue.jobs.some(
    (job) => job.state === "running" || job.state === "cancelling",
  );

  // The drop zone above already says what to do; an empty queue adds nothing.
  if (ready && !queue.jobs.length && !error) return null;
  return (
    <section
      className="card content-stack min-w-0"
      aria-label="Import queue"
      aria-busy={pending}
    >
      <div className="section-heading">
        <div>
          <h3>Import queue</h3>
          <p>
            {queue.jobs.length} of {IMPORT_QUEUE_LIMIT} files ·{" "}
            {queue.paused ? "paused" : "one at a time"}
          </p>
        </div>
      </div>
      {(!!queue.jobs.length || !ready) && (
        <div className="panel-actions">
          <button
            className="secondary-button compact"
            disabled={disabled}
            onClick={() =>
              void command(() => bridge.pauseImportQueue(!queue.paused))
            }
          >
            {queue.paused ? <Play /> : <Pause />}{" "}
            {queue.paused ? "Resume queue" : "Pause queue"}
          </button>
          <button
            className="tool-button compact"
            disabled={disabled || !finished}
            onClick={() => void command(() => bridge.clearFinishedImports())}
          >
            Clear finished
          </button>
          {!ready && (
            <button
              className="tool-button compact"
              disabled={pending}
              onClick={() => void command(() => bridge.getImportQueue())}
            >
              <RotateCcw /> Reload queue
            </button>
          )}
        </div>
      )}
      {!!queue.jobs.length && (
        <details className="disclosure">
          <summary>How the queue works</summary>
          <p className="caption">
            {queue.paused
              ? active
                ? "Queue paused; current work finishes before the next job can start."
                : "Queue paused. Resume to process queued files one at a time."
              : "Files are processed one at a time. Pausing lets current work finish."}{" "}
            Cancellation stops media conversion where possible. Native inference
            may need to settle; cancelled results are discarded.
          </p>
        </details>
      )}
      {error && (
        <p className="field-error break-words" role="alert">
          {error}
        </p>
      )}
      <ol className="queue-jobs" aria-label="Import jobs">
        {queue.jobs.map((job) => {
          const queuedIndex = queued.findIndex((item) => item.id === job.id);
          return (
            <li key={job.id} className="queue-job">
              <div className="flex gap-2 items-center">
                <strong className="min-w-0 flex-1 truncate">{job.name}</strong>
                <span
                  className={`badge ${job.state === "completed" ? "success" : job.state === "failed" ? "danger" : job.state === "queued" || job.state === "cancelled" ? "neutral" : ""}`}
                >
                  {job.state === "cancelling"
                    ? "Cancelling…"
                    : job.state === "running"
                      ? "Transcribing"
                      : job.state[0].toUpperCase() + job.state.slice(1)}
                </span>
              </div>
              {job.error && (
                <p className="field-error break-words mt-2">{job.error}</p>
              )}
              <div className="panel-actions mt-2 empty:hidden">
                {job.state === "queued" && (
                  <>
                    <button
                      className="tool-button compact"
                      disabled={disabled || queuedIndex === 0}
                      aria-label={`Move ${job.name} up`}
                      onClick={() =>
                        void command(() => bridge.moveImportJob(job.id, -1))
                      }
                    >
                      <ArrowUp /> Move up
                    </button>
                    <button
                      className="tool-button compact"
                      disabled={disabled || queuedIndex === queued.length - 1}
                      aria-label={`Move ${job.name} down`}
                      onClick={() =>
                        void command(() => bridge.moveImportJob(job.id, 1))
                      }
                    >
                      <ArrowDown /> Move down
                    </button>
                  </>
                )}
                {(job.state === "queued" || job.state === "running") && (
                  <button
                    className="tool-button compact"
                    disabled={disabled}
                    aria-label={`Cancel ${job.name}`}
                    onClick={() =>
                      void command(() => bridge.cancelImportJob(job.id))
                    }
                  >
                    <X /> Cancel
                  </button>
                )}
                {(job.state === "failed" || job.state === "cancelled") && (
                  <button
                    className="secondary-button compact"
                    disabled={disabled}
                    aria-label={`Retry ${job.name}`}
                    onClick={() =>
                      void command(() => bridge.retryImportJob(job.id))
                    }
                  >
                    <RotateCcw /> Retry
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
