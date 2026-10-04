import { randomUUID } from "node:crypto";
import {
  IMPORT_QUEUE_LIMIT,
  type ImportQueueJob,
  type ImportQueueSnapshot,
} from "../../src/importQueue";

type Runner = (path: string, signal: AbortSignal) => Promise<{ id: string }>;
type SelectedFile = {
  path: string;
  name: string;
  size: number;
  sourceMtimeMs?: number;
};

/** In-memory metadata queue. One runner remains active until it fully settles. */
export class ImportQueue {
  private jobs: ImportQueueJob[] = [];
  private paused = true;
  private version = 0;
  private closed = false;
  private durable: ImportQueueSnapshot = { version: 0, paused: true, jobs: [] };
  private active: { id: string; controller: AbortController } | null = null;

  constructor(
    private readonly runner: Runner,
    private readonly changed: (snapshot: ImportQueueSnapshot) => void,
    private readonly persist?: (snapshot: ImportQueueSnapshot) => void,
    initial: ImportQueueJob[] = [],
  ) {
    this.jobs = initial.map((job) => ({ ...job }));
    this.durable = this.get();
  }

  get(): ImportQueueSnapshot {
    return {
      version: this.version,
      paused: this.paused,
      jobs: this.jobs.map((job) => ({ ...job })),
    };
  }

  replace(jobs: ImportQueueJob[]): ImportQueueSnapshot {
    this.requireOpen();
    if (this.active)
      throw new Error(
        "Wait for the current import before replacing or relinking jobs",
      );
    this.paused = true;
    this.jobs = jobs.map((job) => ({ ...job }));
    this.emit();
    return this.get();
  }

  enqueue(file: SelectedFile): ImportQueueSnapshot {
    this.requireOpen();
    if (this.jobs.length >= IMPORT_QUEUE_LIMIT)
      throw new Error(
        `The import queue is full (${IMPORT_QUEUE_LIMIT} jobs). Clear finished jobs first.`,
      );
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path.trim() ||
      typeof file.name !== "string" ||
      !file.name.trim() ||
      !Number.isFinite(file.size) ||
      file.size < 0
    ) {
      throw new Error("Invalid selected import file.");
    }
    if (this.jobs.some((job) => job.path === file.path))
      throw new Error(
        "This source already has a job; retry or relink it instead",
      );
    this.jobs.push({
      id: randomUUID(),
      path: file.path,
      name: file.name,
      size: file.size,
      sourceMtimeMs: file.sourceMtimeMs,
      state: "queued",
      error: null,
      transcriptId: null,
    });
    this.emit();
    this.pump();
    return this.get();
  }

  setPaused(paused: boolean): ImportQueueSnapshot {
    this.requireOpen();
    if (typeof paused !== "boolean")
      throw new Error("Invalid import pause state.");
    if (this.paused !== paused) {
      this.paused = paused;
      this.emit();
    }
    this.pump();
    return this.get();
  }

  move(id: string, direction: -1 | 1): ImportQueueSnapshot {
    if (this.closed || (direction !== -1 && direction !== 1)) return this.get();
    const queued = this.jobs
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.state === "queued");
    const position = queued.findIndex(({ job }) => job.id === id);
    const other = position + direction;
    if (position < 0 || other < 0 || other >= queued.length) return this.get();
    const first = queued[position].index;
    const second = queued[other].index;
    [this.jobs[first], this.jobs[second]] = [
      this.jobs[second],
      this.jobs[first],
    ];
    this.emit();
    return this.get();
  }

  cancel(id: string): ImportQueueSnapshot {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return this.get();
    if (job.state === "queued") {
      job.state = "cancelled";
      this.emit();
    } else if (job.state === "running" && this.active?.id === id) {
      job.state = "cancelling";
      const controller = this.active.controller;
      this.emit();
      controller.abort();
    }
    return this.get();
  }

  retry(id: string): ImportQueueSnapshot {
    this.requireOpen();
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0 || this.active?.id === id) return this.get();
    const job = this.jobs[index];
    if (job.state !== "failed" && job.state !== "cancelled") return this.get();
    this.jobs.splice(index, 1);
    job.state = "queued";
    job.error = null;
    job.transcriptId = null;
    this.jobs.push(job);
    this.emit();
    this.pump();
    return this.get();
  }

  clearFinished(): ImportQueueSnapshot {
    const remaining = this.jobs.filter(
      (job) =>
        job.state !== "completed" &&
        job.state !== "failed" &&
        job.state !== "cancelled",
    );
    if (remaining.length !== this.jobs.length) {
      this.jobs = remaining;
      this.emit();
    }
    return this.get();
  }

  shutdown(): ImportQueueSnapshot {
    if (this.closed) return this.get();
    this.closed = true;
    this.paused = true;
    for (const job of this.jobs) {
      if (job.state === "running") job.state = "cancelling";
    }
    const controller = this.active?.controller;
    try {
      this.emit();
    } finally {
      controller?.abort();
    }
    return this.get();
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("The import queue has shut down.");
  }

  private emit(): void {
    this.version += 1;
    try {
      this.persist?.(this.get());
      this.durable = this.get();
    } catch (error) {
      const active = this.jobs.find((job) => job.id === this.active?.id);
      this.jobs = this.durable.jobs.map((job) =>
        active?.id === job.id ? Object.assign(active, job) : { ...job },
      );
      this.paused = true;
      throw error;
    }
    // A detached renderer/subscriber cannot interrupt cancellation or leave the
    // runner promise unhandled. Subscribers always receive independent clones.
    try {
      this.changed(this.get());
    } catch {
      /* Subscriber is unavailable. */
    }
  }

  private pump(): void {
    if (this.closed || this.paused || this.active) return;
    const job = this.jobs.find((item) => item.state === "queued");
    if (!job) return;
    const controller = new AbortController();
    this.active = { id: job.id, controller };
    job.state = "running";
    try {
      this.emit();
    } catch (error) {
      this.active = null;
      throw error;
    }
    void this.run(job, controller);
  }

  private async run(
    job: ImportQueueJob,
    controller: AbortController,
  ): Promise<void> {
    try {
      // Cancellation in a synchronous subscriber can happen before invocation.
      if (!controller.signal.aborted) {
        const result = await this.runner(job.path, controller.signal);
        if (!controller.signal.aborted) {
          if (!result || typeof result.id !== "string" || !result.id)
            throw new Error(
              "The import runner returned no transcript identifier.",
            );
          job.state = "completed";
          job.transcriptId = result.id;
          job.error = null;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        job.state = "failed";
        this.paused = true;
        job.error = (
          error instanceof Error ? error.message : "Import failed."
        ).slice(0, 500);
      }
    } finally {
      if (controller.signal.aborted) {
        job.state = "cancelled";
        job.error = null;
        job.transcriptId = null;
      }
      // Release ownership only after the runner promise resolves or rejects.
      this.active = null;
      try {
        this.emit();
        this.pump();
      } catch (error) {
        this.paused = true;
        const current = this.jobs.find((item) => item.id === job.id);
        if (current) {
          current.state = "failed";
          current.error = `Job metadata could not be saved. Check History before retrying: ${error instanceof Error ? error.message : String(error)}`;
        }
        this.version++;
        try {
          this.changed(this.get());
        } catch {}
      }
    }
  }
}
