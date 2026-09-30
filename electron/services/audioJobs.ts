import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_AUDIO_BATCH_FILES, MAX_AUDIO_FILE_BYTES } from "../../src/audioFormats";
import type { AudioFileSelection, AudioImportJob } from "../../src/types";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const STATES = ["pending", "running", "done", "failed", "cancelled"];
type JobChanges = Partial<Pick<AudioImportJob, "state" | "resultId" | "error">>;

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function selection(value: unknown): AudioFileSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid audio job metadata");
  const source = value as Record<string, unknown>;
  if (
    !boundedString(source.path, 4096) || !isAbsolute(source.path) ||
    !boundedString(source.name, 512) ||
    typeof source.size !== "number" || !Number.isSafeInteger(source.size) ||
    source.size < 0 || source.size > MAX_AUDIO_FILE_BYTES
  ) throw new Error("Invalid audio job file metadata");
  return { path: source.path, name: source.name, size: source.size, ...(typeof source.sourceMtimeMs === "number" && Number.isFinite(source.sourceMtimeMs) && source.sourceMtimeMs >= 0 ? { sourceMtimeMs: source.sourceMtimeMs } : {}) };
}

function persistedJob(value: unknown): AudioImportJob {
  const file = selection(value);
  const source = value as Record<string, unknown>;
  if (
    typeof source.state !== "string" || !STATES.includes(source.state) ||
    typeof source.createdAt !== "number" || !Number.isFinite(source.createdAt) || source.createdAt < 0 ||
    typeof source.updatedAt !== "number" || !Number.isFinite(source.updatedAt) || source.updatedAt < 0 ||
    (source.resultId !== undefined && !boundedString(source.resultId, 128)) ||
    (source.error !== undefined && (typeof source.error !== "string" || source.error.length > 500))
  ) throw new Error("Invalid audio job status metadata");
  return {
    ...file,
    ...(typeof source.queueId === "string" && source.queueId.length <= 128 ? { queueId: source.queueId } : {}),
    ...(typeof source.queueState === "string" && ["queued","running","cancelling","completed","failed","cancelled"].includes(source.queueState) ? { queueState: source.queueState as AudioImportJob["queueState"] } : {}),
    state: source.state as AudioImportJob["state"],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(typeof source.resultId === "string" ? { resultId: source.resultId } : {}),
    ...(typeof source.error === "string" ? { error: source.error } : {}),
  };
}

export class AudioJobsService {
  private readonly filePath: string;
  private jobs: AudioImportJob[] = [];

  constructor(private readonly directory: string) {
    this.filePath = join(directory, "import-jobs.json");
    try {
      if (statSync(this.filePath).size > MAX_JSON_BYTES)
        throw new Error("Import jobs file exceeds the 4 MiB metadata limit");
      const data: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Expected an import jobs object");
      const source = data as Record<string, unknown>;
      if (source.schemaVersion !== 1)
        throw new Error("Unsupported import jobs schemaVersion; expected 1");
      if (!Array.isArray(source.jobs) || source.jobs.length > MAX_AUDIO_BATCH_FILES)
        throw new Error(`Expected at most ${MAX_AUDIO_BATCH_FILES} import jobs`);
      const jobs = Array.from(source.jobs, persistedJob);
      if (new Set(jobs.map((job) => job.path)).size !== jobs.length)
        throw new Error("Duplicate import job paths");
      const now = Date.now();
      this.jobs = jobs.map((job) => job.state === "running"
        ? { ...job, state: "failed", updatedAt: now, error: "Interrupted; retry explicitly" }
        : job);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(
        `Could not load audio jobs at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}. The file has been preserved. Restore a compatible backup or repair this metadata file before reopening Audio files.`,
        { cause: error },
      );
    }
  }

  replaceQueue(jobs: import("../../src/importQueue").ImportQueueJob[]): void {
    if (jobs.length > MAX_AUDIO_BATCH_FILES) throw new Error("Too many durable import jobs");
    const previous = new Map(this.jobs.map(job => [job.path, job]));
    const now = Date.now();
    this.persist(jobs.map(job => persistedJob({ ...previous.get(job.path), path: job.path, name: job.name, size: job.size, sourceMtimeMs: job.sourceMtimeMs, createdAt: previous.get(job.path)?.createdAt ?? now, updatedAt: now, queueId: job.id, queueState: job.state, state: job.state === "completed" ? "done" : job.state === "queued" ? "pending" : job.state === "cancelling" ? "running" : job.state, resultId: job.transcriptId ?? undefined, error: job.error ?? undefined })));
  }

  getJobs(): AudioImportJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  replaceSelection(files: AudioFileSelection[]): AudioImportJob[] {
    if (!Array.isArray(files) || files.length > MAX_AUDIO_BATCH_FILES)
      throw new Error(`Choose at most ${MAX_AUDIO_BATCH_FILES} import files`);
    const selected = [...new Map(
      Array.from(files, selection).map((file) => [file.path, file]),
    ).values()];
    const now = Date.now();
    this.persist(selected.map((file) => ({ ...file, state: "pending", createdAt: now, updatedAt: now })));
    return this.getJobs();
  }

  update(path: string, changes: JobChanges): AudioImportJob {
    const index = this.jobs.findIndex((job) => job.path === path);
    if (index < 0) throw new Error("Audio job no longer exists; select the file again explicitly");
    if (!changes || typeof changes !== "object" || Array.isArray(changes))
      throw new Error("Invalid audio job update");
    const updated = { ...this.jobs[index], updatedAt: Date.now() };
    if (changes.state !== undefined) {
      if (!STATES.includes(changes.state)) throw new Error("Invalid audio job state");
      updated.state = changes.state;
    }
    if (Object.hasOwn(changes, "resultId")) {
      if (changes.resultId !== undefined && !boundedString(changes.resultId, 128))
        throw new Error("Invalid audio job result ID");
      if (changes.resultId === undefined) delete updated.resultId;
      else updated.resultId = changes.resultId;
    }
    if (Object.hasOwn(changes, "error")) {
      if (changes.error !== undefined && typeof changes.error !== "string")
        throw new Error("Invalid audio job error");
      if (changes.error === undefined) delete updated.error;
      else updated.error = changes.error.slice(0, 500);
    }
    this.persist(this.jobs.map((job, position) => position === index ? updated : job));
    return { ...updated };
  }

  relink(oldPath: string, file: AudioFileSelection): AudioImportJob {
    const index = this.jobs.findIndex((job) => job.path === oldPath);
    if (index < 0)
      throw new Error("Audio job no longer exists; select the file again explicitly");
    if (this.jobs[index].state === "running")
      throw new Error("Wait for this audio job to finish before relinking its source");
    const replacement = selection(file);
    if (this.jobs.some((job, position) => position !== index && job.path === replacement.path))
      throw new Error("This source file already belongs to another audio job");
    const updated: AudioImportJob = {
      ...replacement,
      state: "pending",
      createdAt: this.jobs[index].createdAt,
      updatedAt: Date.now(),
    };
    this.persist(this.jobs.map((job, position) => position === index ? updated : job));
    return { ...updated };
  }

  remove(path: string): void {
    this.persist(this.jobs.filter((job) => job.path !== path));
  }

  private persist(jobs: AudioImportJob[]): void {
    const metadata = jobs.map(persistedJob);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.import-jobs-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, jobs: metadata })}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      renameSync(temporary, this.filePath);
      this.jobs = metadata;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
