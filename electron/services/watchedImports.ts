import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AudioFileSelection } from "../../src/types";
import type { ImportQueue } from "./importQueue";
import type { WatchedImport } from "../../src/localAutomation";

type Receipt = { hash: string; path: string; jobId: string | null };
type StoredWatch = Omit<WatchedImport, "error" | "imported"> & { receipts: Receipt[] };
const LIMIT = 5000;

/** Explicit, nonrecursive, stable-file ingestion into the same durable UI queue. */
export class WatchedImportService {
  private watches: StoredWatch[] = [];
  private errors = new Map<string, string>();
  private observed = new Map<string, string>();
  private hashes = new Map<string, { signature: string; hash: string }>();
  private persistenceError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopping = false;
  private readonly path: string;

  constructor(private readonly dataDirectory: string, private readonly getQueue: () => ImportQueue, private readonly inspect: (path: string) => AudioFileSelection) {
    this.path = join(dataDirectory, "watched-imports.json");
  }

  async initialize(): Promise<void> {
    try {
      const info = await stat(this.path);
      if (info.size > 4 * 1024 * 1024) throw new Error("Watched import ledger exceeds 4 MiB");
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (value.schemaVersion !== 1 || !Array.isArray(value.watches) || value.watches.length > 8) throw new Error("Unsupported watched import schema");
      for (const watch of value.watches) {
        if (!watch || typeof watch.id !== "string" || typeof watch.directory !== "string" || !isAbsolute(watch.directory) || typeof watch.enabled !== "boolean" || typeof watch.autoRun !== "boolean" || !Array.isArray(watch.receipts) || watch.receipts.length > LIMIT || watch.receipts.some((receipt: Receipt) => !receipt || !/^[0-9a-f]{64}$/.test(receipt.hash) || typeof receipt.path !== "string" || (receipt.jobId !== null && typeof receipt.jobId !== "string"))) throw new Error("Invalid watched import ledger; existing file was preserved");
      }
      this.watches = value.watches;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.persistenceError = error instanceof Error ? error.message : String(error); throw error; } }
    this.timer = setInterval(() => { void this.poll(); }, 3000);
    this.timer.unref();
  }

  get(): WatchedImport[] {
    return this.watches.map(({ receipts, ...watch }) => ({ ...watch, imported: receipts.filter((receipt) => receipt.jobId !== null).length, error: this.errors.get(watch.id) ?? null }));
  }

  private async save(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const stage = `${this.path}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify({ schemaVersion: 1, watches: this.watches }, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error("Watched import ledger is full; remove a finished watch before adding more files");
    try {
      await writeFile(stage, serialized, { flag: "wx", mode: 0o600 });
      await rename(stage, this.path);
    } finally { await rm(stage, { force: true }); }
  }

  async add(directory: string, autoRun: boolean): Promise<WatchedImport[]> {
    if (this.persistenceError) throw new Error(this.persistenceError);
    if (this.busy) throw new Error("Wait for the current watched-folder scan");
    if (typeof directory !== "string" || !isAbsolute(directory) || typeof autoRun !== "boolean") throw new Error("Choose an absolute watched directory and explicit run policy");
    const path = await realpath(directory);
    if (!(await stat(path)).isDirectory()) throw new Error("Watch a directory");
    const dataRoot = await realpath(this.dataDirectory);
    const part = relative(dataRoot, path);
    if (!part || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))) throw new Error("Do not watch Delulu's own data, output, or temporary audio directories");
    if (this.watches.length >= 8) throw new Error("Watched folder limit is eight");
    if (this.watches.some((watch) => watch.directory === path)) throw new Error("That folder is already watched");
    this.busy = true;
    const previous = [...this.watches];
    try {
      this.watches.push({ id: randomUUID(), directory: path, enabled: true, autoRun, receipts: [] });
      await this.save(); return this.get();
    } catch (error) { this.watches = previous; throw error; }
    finally { this.busy = false; }
  }

  async remove(id: string): Promise<WatchedImport[]> {
    if (this.persistenceError) throw new Error(this.persistenceError);
    if (this.busy) throw new Error("Wait for the current watched-folder scan");
    if (typeof id !== "string" || id.length > 128) throw new Error("Expected a watched folder ID");
    this.busy = true;
    const previous = this.watches;
    try { this.watches = this.watches.filter((watch) => watch.id !== id); await this.save(); this.errors.delete(id); return this.get(); }
    catch (error) { this.watches = previous; throw error; }
    finally { this.busy = false; }
  }

  async setEnabled(id: string, enabled: boolean): Promise<WatchedImport[]> {
    if (this.persistenceError) throw new Error(this.persistenceError);
    if (this.busy) throw new Error("Wait for the current watched-folder scan");
    if (typeof id !== "string" || typeof enabled !== "boolean" || !this.watches.some((watch) => watch.id === id)) throw new Error("Choose an existing watched folder");
    this.busy = true;
    const previous = this.watches;
    try { this.watches = this.watches.map((watch) => watch.id === id ? { ...watch, enabled } : watch); await this.save(); return this.get(); }
    catch (error) { this.watches = previous; throw error; }
    finally { this.busy = false; }
  }

  private async poll(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    const seen = new Set<string>();
    try {
      for (const watch of this.watches) {
        if (!watch.enabled || this.stopping) continue;
        try {
          if (await realpath(watch.directory) !== watch.directory) throw new Error("Watched directory identity changed; remove and add it explicitly");
          const entries = await readdir(watch.directory, { withFileTypes: true });
          if (entries.length > 2000) throw new Error("Watched folder exceeds 2000 entries; select a focused import folder");
          for (const entry of entries) {
            if (this.stopping) break;
            // Symlinks and nested directories are deliberately ignored.
            if (!entry.isFile() || !/\.(wav|flac|mp3|m4a|ogg|opus|webm|mp4|mov|mkv)$/i.test(entry.name)) continue;
            const path = join(watch.directory, entry.name);
            seen.add(path);
            const info = await stat(path);
            const signature = `${info.size}:${info.mtimeMs}`;
            const previous = this.observed.get(path);
            this.observed.set(path, signature);
            if (!info.size || previous !== signature || Date.now() - info.mtimeMs < 3000) continue;
            const queue = this.getQueue();
            let hash = this.hashes.get(path)?.signature === signature ? this.hashes.get(path)!.hash : null;
            if (!hash) {
              const digest = createHash("sha256");
              for await (const chunk of createReadStream(path)) {
                if (this.stopping) return;
                digest.update(chunk);
              }
              hash = digest.digest("hex");
            }
            const after = await stat(path);
            if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || await realpath(path) !== path) continue;
            this.hashes.set(path, { signature, hash });
            let receipt = watch.receipts.find((item) => item.hash === hash);
            if (receipt?.jobId) continue;
            if (queue.get().jobs.length >= 20) throw new Error("Import queue is full; clear finished jobs to continue watching");
            if (!receipt && watch.receipts.length >= LIMIT) throw new Error("Duplicate ledger is full; remove this watch before choosing a new import folder");
            const file = this.inspect(path);
            // Reserve intent before enqueue. A restart reconciles a pending intent
            // with the durable queue instead of blindly creating another job.
            if (!receipt) {
              receipt = { hash, path, jobId: null }; watch.receipts.push(receipt); await this.save();
            }
            const existing = queue.get().jobs.find((job) => job.path === receipt!.path && job.size === file.size && job.sourceMtimeMs === info.mtimeMs && job.state !== "cancelled");
            if (existing) receipt.jobId = existing.id;
            else {
              const ids = new Set(queue.get().jobs.map((job) => job.id));
              const next = queue.enqueue(file);
              const job = next.jobs.find((job) => !ids.has(job.id));
              if (!job) throw new Error("Queue did not retain the watched import");
              receipt.jobId = job.id;
            }
            await this.save();
            if (watch.autoRun) queue.setPaused(false);
          }
          this.errors.delete(watch.id);
        } catch (error) { this.errors.set(watch.id, error instanceof Error ? error.message : String(error)); }
      }
      for (const path of this.observed.keys()) if (!seen.has(path)) { this.observed.delete(path); this.hashes.delete(path); }
    } finally { this.busy = false; }
  }

  shutdown(): void { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
