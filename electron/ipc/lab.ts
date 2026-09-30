import { createHash } from "node:crypto";
import { ImportQueue } from "../services/importQueue";
import type { ImportQueueJob } from "../../src/importQueue";
import { dialog } from "electron";
import { existsSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { MAX_AUDIO_BATCH_FILES, MAX_AUDIO_FILE_BYTES, SUPPORTED_AUDIO_EXTENSIONS } from "../../src/audioFormats";
import type { AudioFileSelection, LabRequest, TranscriptRecord } from "../../src/types";
import { AudioJobsService } from "../services/audioJobs";
import { loadLinkedAudio } from "../services/audioSource";
import { inspectMedia } from "../services/mediaInspection";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";
export function validateAudioFile(value: unknown): AudioFileSelection {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("Invalid audio file path");
  const path = resolve(value);
  const name = basename(path);
  const extension = extname(path).slice(1).toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.includes(extension))
    throw new Error(`${name}: unsupported audio or video format`);
  let info: Stats;
  try {
    info = statSync(path);
  } catch {
    throw new Error(`${name}: file does not exist or cannot be accessed`);
  }
  if (!info.isFile()) throw new Error(`${name}: choose a regular file`);
  if (info.size > MAX_AUDIO_FILE_BYTES)
    throw new Error(`${name}: file exceeds the 500 MiB limit`);
  return { path, name, size: info.size, sourceMtimeMs: info.mtimeMs };
}


export function registerLabIpc({handle}: IpcRegistrar, {storage, dictation, asr, getMainWindow, selectedAudioFiles, broadcast}: IpcDependencies) {
  let audioJobs: AudioJobsService | null = null;
  const importJobs = () => audioJobs ??= new AudioJobsService(storage.dataDirectory);
  let queue: ImportQueue | null = null;
  const restoredJobs = (): ImportQueueJob[] => importJobs().getJobs().map(job => {
    let state: ImportQueueJob["state"] = job.queueState ?? (job.state === "pending" ? "queued" : job.state === "done" ? "completed" : job.state === "cancelled" ? "cancelled" : "failed");
    if (state === "running" || state === "cancelling") state = "failed";
    return { id: job.queueId ?? createHash("sha256").update(job.path).digest("hex"), path: job.path, name: job.name, size: job.size, sourceMtimeMs: job.sourceMtimeMs, state, error: job.error ?? null, transcriptId: job.resultId ?? null };
  });
  const getImportQueue = () => queue ??= new ImportQueue(async (path, signal) => {
    validateAudioFile(path);
    if (!importJobs().getJobs().some(job => job.path === path)) throw new Error("Import job no longer exists");
    return dictation.runLab({path}, signal);
  }, snapshot => broadcast("lab:queueChanged", snapshot), snapshot => importJobs().replaceQueue(snapshot.jobs), restoredJobs());
  handle("lab:queueGet", () => getImportQueue().get());
  handle("lab:queueEnqueue", (_event, path: string) => {
    const file = validateAudioFile(path);
    if (!selectedAudioFiles.has(file.path)) throw new Error("Select this source through Audio files first");
    return getImportQueue().enqueue(file);
  });
  handle("lab:queuePause", (_event, paused: boolean) => getImportQueue().setPaused(paused));
  handle("lab:queueMove", (_event, id: string, direction: -1 | 1) => getImportQueue().move(id,direction));
  handle("lab:queueCancel", (_event, id: string) => getImportQueue().cancel(id));
  handle("lab:queueRetry", (_event, id: string) => {
    const job = getImportQueue().get().jobs.find(job => job.id === id);
    if (job) validateAudioFile(job.path);
    return getImportQueue().retry(id);
  });
  handle("lab:queueClearFinished", () => getImportQueue().clearFinished());

function selectAudioFiles(value: unknown): AudioFileSelection[] {
  if (!Array.isArray(value) || value.length > MAX_AUDIO_BATCH_FILES)
    throw new Error(`Choose at most ${MAX_AUDIO_BATCH_FILES} files at once`);
  const files = Array.from(value, validateAudioFile);
  // Register only after every file passes, so invalid batches are rejected whole.
  if (dictation.isActive || asr.isBusy || getImportQueue().get().jobs.some(job => ["running","cancelling"].includes(job.state))) throw new Error("Finish the active operation before replacing sources");
  const existing = getImportQueue().get().jobs;
  const additions = files.filter(file => !existing.some(job => job.path === file.path)).map(file => ({...file, id: createHash("sha256").update(file.path).digest("hex"), state: "queued" as const, error: null, transcriptId: null }));
  if (existing.length + additions.length > MAX_AUDIO_BATCH_FILES) throw new Error("Clear finished imports before adding more files");
  getImportQueue().replace([...existing,...additions]);
  for (const file of files) selectedAudioFiles.add(file.path);
  return files;
}

  const chooseAudioFiles = async (multiple: boolean, register = true): Promise<AudioFileSelection[]> => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose audio or video",
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [
        { name: "Audio and video", extensions: SUPPORTED_AUDIO_EXTENSIONS },
      ],
    };
    const result = getMainWindow()
      ? await dialog.showOpenDialog(getMainWindow(), options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : register ? selectAudioFiles(result.filePaths) : result.filePaths.map(validateAudioFile);
  };
  handle("lab:chooseAudio", async () => (await chooseAudioFiles(false))[0] ?? null);
  handle("lab:chooseAudioFiles", () => chooseAudioFiles(true));
  handle("lab:resolveAudioFiles", (_event, paths: unknown) => selectAudioFiles(paths));
  handle("lab:run", async (_event, request: LabRequest) => {
    if (getImportQueue().get().jobs.some(job => ["running","cancelling"].includes(job.state))) throw new Error("Wait for the active queued import");
    const file = validateAudioFile(request?.path);
    if (!selectedAudioFiles.has(file.path))
      throw new Error("Choose or drop the source file through Audio files first");
    importJobs().update(file.path, { state: "running", error: undefined });
    let record: TranscriptRecord;
    try {
      record = await dictation.runLab({ path: file.path });
    } catch (reason) {
      importJobs().update(file.path, { state: "failed", error: reason instanceof Error ? reason.message : String(reason) });
      throw reason;
    }
    try {
      importJobs().update(file.path, { state: "done", resultId: record.id, error: undefined });
    } catch (reason) {
      throw new Error(`Transcription completed (${record.id}), but job metadata could not be saved. Check History before retrying: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    return record;
  });
  handle("lab:getJobs", () => importJobs().getJobs().map((job) => {
    try {
      const file = validateAudioFile(job.path);
      selectedAudioFiles.add(file.path);
      return { ...job, sourceAvailable: true };
    } catch (reason) {
      return { ...job, state: job.state === "done" ? "done" : "failed", sourceAvailable: false, sourceError: reason instanceof Error ? reason.message : String(reason) };
    }
  }));
  handle("lab:loadSource", async (_event, path: unknown) => {
    const key = resolve(validateText(path, 4096));
    if (!importJobs().getJobs().some((job) => job.path === key))
      throw new Error("Link this source through Audio files before reviewing it");
    validateAudioFile(key);
    return loadLinkedAudio(key);
  });
  handle("lab:relinkJob", async (_event, path: unknown) => {
    if (dictation.isActive || asr.isBusy) throw new Error("Finish the current operation before relinking a source");
    const key = resolve(validateText(path, 4096));
    if (!importJobs().getJobs().some((job) => job.path === key))
      throw new Error("This import job was removed");
    const file = (await chooseAudioFiles(false, false))[0];
    if (!file) return null;
    if (dictation.isActive || asr.isBusy) throw new Error("Relink cancelled because another operation started");
    const current = validateAudioFile(file.path);
    const updated = importJobs().relink(key, current);
    getImportQueue().replace(restoredJobs());
    selectedAudioFiles.delete(key);
    selectedAudioFiles.add(updated.path);
    return { ...updated, sourceAvailable: true };
  });
  handle("lab:removeJob", (_event, path: unknown) => {
    if (dictation.isActive) throw new Error("Finish the current recording or import first");
    const key = resolve(validateText(path, 4096));
    if (getImportQueue().get().jobs.some(job => ["running","cancelling"].includes(job.state))) throw new Error("Wait for the active queued import");
    importJobs().remove(key);
    getImportQueue().replace(restoredJobs());
    selectedAudioFiles.delete(key);
  });

handle("lab:inspectAudio", (_event, value: unknown) => {
 const path = resolve(validateText(value,4096));
 if (!selectedAudioFiles.has(path) || !existsSync(path)) throw new Error("Choose the source file through Audio files first");
 return inspectMedia(path, storage);
});
  return { getImportQueue };

}
