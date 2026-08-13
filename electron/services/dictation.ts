import type { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  LabRequest,
  RecorderCommand,
  RecordingSubmission,
  TranscriptRecord,
  TranscriptionMode,
  WordTimestamp,
} from "../../src/types";
import type { AsrService } from "./asr";
import type { PasteService } from "./paste";
import type { PillService } from "./pill";
import type { StorageService } from "./storage";
import { deriveInsights } from "./transcripts";

type WindowProvider = {
  main(): BrowserWindow | null;
  pill: PillService;
};

type CaptureState = "idle" | "opening" | "listening" | "stopping" | "processing";

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function words(value: unknown): WordTimestamp[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const word = String((item as Record<string, unknown>).word ?? "").trim();
    if (!word) return [];
    return [{
      word,
      start: Math.max(0, numeric((item as Record<string, unknown>).start)),
      end: Math.max(0, numeric((item as Record<string, unknown>).end)),
    }];
  });
}

export class DictationService {
  private captureState: CaptureState = "idle";
  private recorderReady = false;

  constructor(
    private readonly storage: StorageService,
    private readonly asr: AsrService,
    private readonly paste: PasteService,
    private readonly windows: WindowProvider,
    private readonly broadcastTranscript: (record: TranscriptRecord) => void,
  ) {}

  private settings(): AppSettings {
    return this.storage.getSettings();
  }

  private sendRecorder(command: RecorderCommand): void {
    const window = this.windows.main();
    if (!window || window.isDestroyed() || !this.recorderReady) {
      this.captureState = "idle";
      this.asr.setActivity("error", "The microphone controller is still starting — try again in a moment");
      this.showPill("error");
      return;
    }
    window.webContents.send("recorder:command", command);
  }

  private showPill(state: Parameters<PillService["show"]>[0], detail?: string, title?: string): void {
    if (this.settings().showOverlay) this.windows.pill.show(state, detail, title);
    else this.windows.pill.hide();
  }

  recorderAvailable(): void {
    this.recorderReady = true;
  }

  recorderUnavailable(): void {
    this.recorderReady = false;
    if (this.captureState !== "idle") {
      this.captureState = "idle";
      this.windows.pill.hide();
      this.asr.setActivity("error", "The app reloaded while recording; please start again");
    }
  }

  start(): void {
    const status = this.asr.getStatus();
    if (this.captureState !== "idle") return;
    if (["transcribing", "preparing", "loading"].includes(status.phase)) {
      this.showPill("transcribing", status.message, "Please wait");
      return;
    }
    if (status.engine === "missing" || status.engine === "error") {
      this.asr.setActivity("error", status.engine === "missing"
        ? "Set up a CrisperWhisper model before your first dictation"
        : "Repair or reload the speech engine before starting another dictation");
      this.showPill("error", status.engine === "missing" ? "Install a speech model in Delulu Talks" : "Open Delulu Talks for details", status.engine === "missing" ? "Setup needed" : "Engine unavailable");
      return;
    }
    if (!this.recorderReady) {
      this.asr.setActivity("error", "The microphone controller is still starting — try again in a moment");
      this.showPill("error");
      return;
    }
    const settings = this.settings();
    this.captureState = "opening";
    this.asr.setActivity("idle", "Opening microphone");
    this.sendRecorder({ action: "start", inputDeviceId: settings.inputDeviceId });
  }

  stop(): void {
    if (this.captureState === "opening") {
      this.captureState = "stopping";
      this.asr.setActivity("idle", "Shortcut released — closing the microphone");
      return;
    }
    if (this.captureState !== "listening") return;
    this.captureState = "stopping";
    this.sendRecorder({ action: "stop", inputDeviceId: this.settings().inputDeviceId });
  }

  toggle(): void {
    if (this.captureState === "opening" || this.captureState === "listening") this.stop();
    else if (this.captureState === "idle") this.start();
  }

  cancel(): void {
    if (this.captureState === "idle" || this.captureState === "processing") return;
    this.captureState = "idle";
    this.sendRecorder({ action: "cancel", inputDeviceId: this.settings().inputDeviceId });
    this.windows.pill.hide();
    this.asr.setActivity("idle", "Recording cancelled");
  }

  recordingStarted(): void {
    if (this.captureState === "stopping") {
      this.asr.setActivity("listening", "Finishing capture");
      this.sendRecorder({ action: "stop", inputDeviceId: this.settings().inputDeviceId });
      return;
    }
    if (this.captureState !== "opening") return;
    this.captureState = "listening";
    const hold = this.settings().shortcutMode === "hold";
    this.asr.setActivity("listening", hold ? "Listening — release the shortcut to transcribe" : "Listening — press the shortcut again to finish");
    this.showPill("listening", hold ? "Release to send" : "Press shortcut to send");
  }

  recordingFailed(message: string): void {
    this.captureState = "idle";
    this.showPill("error");
    this.asr.setActivity("error", message);
  }

  async submitRecording(submission: RecordingSubmission): Promise<void> {
    this.captureState = "processing";
    const settings = this.settings();
    if (!(submission.wav instanceof Uint8Array) || submission.wav.byteLength < 44) {
      this.recordingFailed("The microphone returned an empty recording");
      return;
    }
    if (submission.wav.byteLength > 500 * 1024 * 1024) {
      this.recordingFailed("Recording is too large; keep dictation captures below 500 MB");
      return;
    }
    if (submission.durationMs < 180) {
      this.captureState = "idle";
      this.windows.pill.hide();
      this.asr.setActivity("idle", "Recording was too short and was discarded");
      return;
    }

    mkdirSync(this.storage.cacheDirectory, { recursive: true });
    const audioPath = join(this.storage.cacheDirectory, `dictation-${Date.now()}-${randomUUID()}.wav`);
    writeFileSync(audioPath, submission.wav);
    try {
      this.asr.setActivity("transcribing", settings.transcriptionMode === "dual" ? "Creating clean and verbatim transcripts" : "Transcribing locally");
      this.showPill("transcribing");
      const result = await this.asr.transcribe({ audioPath }, settings);
      let record = this.createRecord(result, "dictation", submission.durationMs, null, settings.transcriptionMode, settings);
      let output = this.outputText(record, settings);
      if (!output.trim()) {
        this.showPill("error", "Try again a little closer to the microphone", "Nothing heard");
        if (!settings.preloadModel) await this.asr.unload();
        this.asr.setActivity("idle", "No speech detected — nothing was copied or pasted");
        return;
      }
      let magicFailure: string | null = null;
      if (settings.magicEnabled) {
        this.asr.setActivity("transcribing", "Magic is polishing the transcript");
        this.showPill("magic");
        try {
          const magic = await this.asr.rewriteMagic({
            text: output,
            preset: settings.magicPreset,
            allowInferences: settings.magicAllowInferences,
          }, settings);
          output = magic.text;
          record = {
            ...record,
            magicText: magic.text,
            magicModel: magic.model,
            magicPreset: settings.magicPreset,
            magicIncludedInferences: magic.includedInferences,
            magicProcessingTimeMs: magic.processingTimeMs,
          };
        } catch (error) {
          magicFailure = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 180);
        }
      }
      this.storage.addHistory(record);
      this.broadcastTranscript(record);
      const outputName = record.magicText ? "Magic result" : "Transcript";
      let completion = `${outputName} ready`;
      this.showPill("delivering");
      if (settings.copyToClipboard || settings.autoPaste) this.paste.copy(output);
      if (settings.autoPaste) {
        try {
          await this.paste.paste(output);
          completion = `${outputName} pasted`;
        } catch (error) {
          completion = `Copied — paste manually (${error instanceof Error ? error.message : String(error)})`;
        }
      } else if (settings.copyToClipboard) {
        completion = `${outputName} copied to clipboard`;
      }
      if (magicFailure) completion = `${completion} · Magic unavailable: ${magicFailure}`;
      if (!settings.preloadModel) await this.asr.unload();
      this.showPill("success", completion, settings.autoPaste ? "Pasted" : settings.copyToClipboard ? "Copied" : "Done");
      this.asr.setActivity("idle", completion);
    } catch (error) {
      this.showPill("error");
      this.asr.setActivity("error", error instanceof Error ? error.message : String(error));
    } finally {
      this.captureState = "idle";
      rmSync(audioPath, { force: true });
    }
  }

  async runLab(request: LabRequest): Promise<TranscriptRecord> {
    const settings = this.settings();
    this.asr.setActivity("transcribing", request.operation === "forcedAlign" ? "Aligning every word" : request.operation === "verbatimize" ? "Recovering spoken detail" : "Transcribing imported audio");
    let preparedAudio: { path: string; temporary: boolean } | null = null;
    try {
      preparedAudio = await this.prepareAudio(request.path);
      const payload = request.operation === "transcribe"
        ? await this.asr.transcribe({ audioPath: preparedAudio.path, mode: request.mode ?? settings.transcriptionMode }, settings)
        : await this.asr.runTool(request.operation, { audioPath: preparedAudio.path, referenceText: request.referenceText }, settings);
      const mode = request.operation === "transcribe" ? (request.mode ?? settings.transcriptionMode) : request.operation;
      const record = this.createRecord(payload, request.operation === "transcribe" ? "file" : request.operation, undefined, basename(request.path), mode, settings);
      this.storage.addHistory(record);
      this.broadcastTranscript(record);
      if (!settings.preloadModel) await this.asr.unload();
      this.asr.setActivity("idle", "Speech Lab result ready");
      return record;
    } catch (error) {
      this.asr.setActivity("error", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (preparedAudio?.temporary) rmSync(preparedAudio.path, { force: true });
    }
  }

  private async prepareAudio(sourcePath: string): Promise<{ path: string; temporary: boolean }> {
    if ([".wav", ".flac", ".ogg", ".opus"].includes(extname(sourcePath).toLowerCase())) {
      return { path: sourcePath, temporary: false };
    }

    mkdirSync(this.storage.cacheDirectory, { recursive: true });
    const outputPath = join(this.storage.cacheDirectory, `import-${Date.now()}-${randomUUID()}.wav`);
    await new Promise<void>((resolveConversion, reject) => {
      const child = spawn("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath,
      ], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-16_000); });
      child.once("error", (error) => {
        rmSync(outputPath, { force: true });
        reject(new Error(`This format needs FFmpeg. Install ffmpeg and try again (${error.message})`));
      });
      child.once("exit", (code) => {
        if (code === 0) resolveConversion();
        else {
          rmSync(outputPath, { force: true });
          reject(new Error(`FFmpeg could not decode this media file: ${stderr.trim() || `exit code ${code}`}`));
        }
      });
    });
    return { path: outputPath, temporary: true };
  }

  private createRecord(
    result: Record<string, unknown>,
    source: TranscriptRecord["source"],
    durationOverride: number | undefined,
    sourceName: string | null,
    mode: TranscriptionMode | "forcedAlign" | "verbatimize",
    settings: AppSettings,
  ): TranscriptRecord {
    const intendedText = String(result.intendedText ?? "").trim();
    const verbatimText = String(result.verbatimText ?? "").trim();
    const primary = String(result.text ?? (intendedText || verbatimText)).trim();
    const timedWords = words(result.words);
    const verbatimWords = words(result.verbatimWords);
    const durationMs = durationOverride ?? Math.round(numeric(result.duration) * 1000);
    const text = intendedText || primary || verbatimText;
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      durationMs,
      text,
      intendedText,
      verbatimText,
      mode,
      model: settings.model,
      language: String(result.language ?? settings.language),
      words: timedWords,
      verbatimWords,
      insights: deriveInsights(verbatimText || text, verbatimWords.length ? verbatimWords : timedWords, durationMs),
      source,
      sourceName,
      processingTimeMs: Math.round(numeric(result.processingTime) * 1000),
    };
  }

  private outputText(record: TranscriptRecord, settings: AppSettings): string {
    return settings.pasteVersion === "verbatim"
      ? record.verbatimText || record.intendedText || record.text
      : record.intendedText || record.verbatimText || record.text;
  }
}
