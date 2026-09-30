import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Pause, Play, Plus, RotateCcw, X } from "lucide-react";
import { bridge } from "../bridge";
import { emptyImportQueue, IMPORT_QUEUE_LIMIT, type ImportQueueSnapshot } from "../importQueue";
import type { AudioFileSelection } from "../types";

export function ImportQueue({ file }: { file: AudioFileSelection | null }) {
  const [queue, setQueue] = useState(emptyImportQueue);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);

  function accept(snapshot: ImportQueueSnapshot) {
    if (!mounted.current) return;
    setQueue((current) => snapshot.version >= current.version ? snapshot : current);
    setReady(true);
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bridge.onImportQueue(accept);
    void bridge.getImportQueue().then(accept).catch((reason: unknown) => {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not load the import queue.");
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
      if (mounted.current) setError(reason instanceof Error ? reason.message : "The queue could not be updated.");
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const disabled = pending || !ready;
  const queued = queue.jobs.filter((job) => job.state === "queued");
  const finished = queue.jobs.some((job) => ["completed", "failed", "cancelled"].includes(job.state));
  const active = queue.jobs.some((job) => job.state === "running" || job.state === "cancelling");

  return <section className="border border-line bg-surface rounded-panel shadow-panel min-w-0 p-5 content-stack" aria-label="Import queue" aria-busy={pending}>
    <div>
      <h3>Import queue</h3>
      <p className="caption">{queue.jobs.length}/{IMPORT_QUEUE_LIMIT} jobs · Saved source/job metadata. Reopening starts paused; source audio stays in place.</p>
    </div>
    <div className="flex gap-2 flex-wrap">
      <button className="secondary-button" disabled={disabled} onClick={() => void command(() => bridge.pauseImportQueue(!queue.paused))}>
        {queue.paused ? <Play /> : <Pause />} {queue.paused ? "Resume queue" : "Pause queue"}
      </button>
      <button className="secondary-button" disabled={disabled || !finished} onClick={() => void command(() => bridge.clearFinishedImports())}>Clear finished</button>
      {!ready && <button className="secondary-button" disabled={pending} onClick={() => void command(() => bridge.getImportQueue())}><RotateCcw /> Reload queue</button>}
    </div>
    <p className="text-muted text-[12px]">
      {queue.paused ? (active ? "Queue paused; current work finishes before the next job can start." : "Queue paused. Resume to process queued files one at a time.") : "Files are processed one at a time. Pausing lets current work finish."}
      {" "}Cancellation stops media conversion where possible. Native inference may need to settle; cancelled results are discarded.
    </p>
    {error && <p className="field-error break-words" role="alert">{error}</p>}
    {ready && !queue.jobs.length && <p className="caption">Choose or drop source files to create queued jobs.</p>}
    <ol className="content-stack" aria-label="Import jobs">
      {queue.jobs.map((job) => {
        const queuedIndex = queued.findIndex((item) => item.id === job.id);
        return <li key={job.id} className="border border-line rounded-lg p-3 min-w-0">
          <div className="flex gap-2 items-center flex-wrap">
            <strong className="break-words min-w-0">{job.name}</strong>
            <span className="badge">{job.state === "cancelling" ? "Cancelling after current work" : job.state}</span>
          </div>
          {job.error && <p className="field-error break-words mt-2">{job.error}</p>}
          <div className="flex gap-2 flex-wrap mt-2">
            {job.state === "queued" && <>
              <button className="secondary-button" disabled={disabled || queuedIndex === 0} aria-label={`Move ${job.name} up`} onClick={() => void command(() => bridge.moveImportJob(job.id, -1))}><ArrowUp /> Move up</button>
              <button className="secondary-button" disabled={disabled || queuedIndex === queued.length - 1} aria-label={`Move ${job.name} down`} onClick={() => void command(() => bridge.moveImportJob(job.id, 1))}><ArrowDown /> Move down</button>
            </>}
            {(job.state === "queued" || job.state === "running") && <button className="secondary-button" disabled={disabled} aria-label={`Cancel ${job.name}`} onClick={() => void command(() => bridge.cancelImportJob(job.id))}><X /> Cancel</button>}
            {(job.state === "failed" || job.state === "cancelled") && <button className="secondary-button" disabled={disabled} aria-label={`Retry ${job.name}`} onClick={() => void command(() => bridge.retryImportJob(job.id))}><RotateCcw /> Retry</button>}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
