import { TOO_SHORT } from "../../src/captureLimits";
import { renderTechnicalDictation } from "../../src/technicalDictation";
import { personalizeWithUsage } from "../../src/personalization";
import { normalizeCaptureDiagnostics } from "../../src/captureDiagnostics";
import { formatSpokenCommands } from "../../src/spokenFormatting";
import { captureProfileSnapshot } from "../../src/activePersonalProfile";
import { normalizeSpeechExecution } from "../../src/speechModels";
import { deliveredText } from "../../src/transcriptText";
import {
  normalizeLanguageMetadata,
  normalizeReportedLanguage,
} from "../../src/transcriptLanguage";
import { formatDictation } from "../../src/dictationFormatting";
import { normalizeTimings } from "../../src/pipelineTimings";
import type { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  LabRequest,
  PipelineTimings,
  RecorderCommand,
  RecordingSubmission,
  TranscriptRecord,
} from "../../src/types";
import type { AsrService } from "./asr";
import { ClipboardCopyError } from "./paste";
import type {
  DesktopPasteAdapter,
  DesktopIndicatorAdapter,
} from "./desktopAdapters";
import type { StorageService } from "./storage";
import { getMicrophonePermission } from "./microphonePermission";
import { RetryAudioStore, type RetryAudioLease } from "./retryAudio";

type WindowProvider = {
  main(): BrowserWindow | null;
  pill: DesktopIndicatorAdapter;
};

type CaptureState =
  | "idle"
  | "opening"
  | "listening"
  | "pausing"
  | "paused"
  | "resuming"
  | "stopping"
  | "processing";

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ACTIVE_CAPTURE: CaptureState[] = [
  "opening",
  "listening",
  "pausing",
  "paused",
  "resuming",
];
const OPENING_DEADLINE_MS = 45_000;
const STOPPING_DEADLINE_MS = 30_000;

class NoSpeechError extends Error {
  constructor() {
    super("No speech detected — nothing was typed.");
  }
}

export class DictationService {
  private readonly retryAudio = new RetryAudioStore();
  private captureSettings: AppSettings | null = null;
  private retrySettings: AppSettings | null = null;
  get isActive(): boolean {
    return this.captureState !== "idle";
  }

  get canStopRecording(): boolean {
    return (
      this.recorderReady &&
      ["opening", "listening", "pausing", "paused", "resuming"].includes(
        this.captureState,
      )
    );
  }
  discardFailure(): void {
    this.retryAudio.discard();
    this.retrySettings = null;
    this.publishRetryAudio();
    if (!this.isActive)
      this.asr.setActivity("idle", "Failed recording discarded");
  }

  releaseRetryAudio(): void {
    this.retryAudio.dispose();
    this.publishRetryAudio();
  }

  private publishRetryAudio(): void {
    this.asr.setRecovery?.(this.retryAudio.available, this.retryAudio.state);
  }

  async retry(): Promise<void> {
    if (this.isActive || !this.retryAudio.available)
      throw new Error("No failed recording is available to retry");
    const lease = this.retryAudio.beginRetry();
    if (!lease) throw new Error("No failed recording is available to retry");
    this.publishRetryAudio();
    let failed = true;
    try {
      failed = !(await this.processRecording(lease.recording, lease));
    } finally {
      this.retryAudio.finishRetry(lease, failed);
      this.publishRetryAudio();
    }
  }

  private captureState: CaptureState = "idle";
  private captureSessionId: string | null = null;
  private recorderReady = false;
  private busyNoticeTimer: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private busyNotice = false;
  private hud:
    Parameters<DesktopIndicatorAdapter["show"]>[0] | { state: "hidden" } = {
    state: "hidden",
  };

  constructor(
    private readonly storage: StorageService,
    private readonly asr: AsrService,
    private readonly paste: DesktopPasteAdapter,
    private readonly windows: WindowProvider,
    private readonly broadcastTranscript: (record: TranscriptRecord) => void,
    private readonly reportPasteFailure: (
      id: string,
      detail: string,
    ) => void = () => undefined,
    private readonly recordRuleUsage: (
      counts: Record<string, number>,
    ) => void = () => {},
    private readonly microphonePermission = getMicrophonePermission,
  ) {}

  private settings(): AppSettings {
    return this.storage.getSettings();
  }

  private sendRecorder(command: RecorderCommand): void {
    const window = this.windows.main();
    if (!window || window.isDestroyed() || !this.recorderReady) {
      this.captureState = "idle";
      this.captureSessionId = null;
      this.captureSettings = null;
      this.asr.setSilenceCountdown?.(null);
      this.asr.setActivity(
        "error",
        "The microphone controller is still starting — try again in a moment",
      );
      this.setHud({
        state: "error",
        title: "Not ready",
        detail: "Try again in a moment",
      });
      return;
    }
    window.webContents.send("recorder:command", command);
  }

  syncOverlay(): void {
    this.applyHud();
  }

  recordingLevel(level: number): void {
    // Called ~20 times a second: read the captured flag instead of cloning settings.
    if (
      this.hud.state === "listening" &&
      (this.captureSettings ?? this.settings()).showOverlay
    )
      this.windows.pill.level(level);
  }

  private setHud(
    command:
      Parameters<DesktopIndicatorAdapter["show"]>[0] | { state: "hidden" },
  ): void {
    if (this.busyNoticeTimer) clearTimeout(this.busyNoticeTimer);
    this.busyNoticeTimer = null;
    this.busyNotice = false;
    this.hud =
      command.state !== "hidden" && this.captureSettings
        ? {
            ...command,
            profile: captureProfileSnapshot(this.captureSettings).label,
          }
        : command;
    this.applyHud();
  }

  runtimeChanged(): void {
    if (
      this.busyNotice &&
      !["loading", "preparing", "transcribing"].includes(
        this.asr.getStatus().phase,
      )
    )
      this.setHud({ state: "hidden" });
  }

  private showBusyNotice(): void {
    this.setHud({
      state: "transcribing",
      title: "Please wait",
      detail: "Engine is busy — try again shortly",
    });
    this.busyNotice = true;
    this.busyNoticeTimer = setTimeout(
      () => this.setHud({ state: "hidden" }),
      2000,
    );
    this.busyNoticeTimer.unref();
  }

  private applyHud(): void {
    if (!this.settings().showOverlay || this.hud.state === "hidden") {
      this.windows.pill.hide();
      return;
    }
    this.windows.pill.show(this.hud);
  }

  recorderAvailable(): void {
    this.recorderReady = true;
  }

  recorderUnavailable(): void {
    this.recorderReady = false;
    this.clearDeadline();
    this.asr.setSilenceCountdown?.(null);
    if (this.captureState !== "idle" && this.captureState !== "processing") {
      this.captureState = "idle";
      this.captureSessionId = null;
      this.captureSettings = null;
      this.setHud({ state: "hidden" });
      this.asr.setActivity(
        "error",
        "The app reloaded while recording; please start again",
      );
    }
  }

  start(): void {
    const status = this.asr.getStatus();
    if (this.captureState !== "idle") {
      // Processing a previous recording: say so instead of ignoring the press.
      if (this.captureState === "processing") this.showBusyNotice();
      return;
    }
    if (
      this.paste.isBusy ||
      this.asr.isBusy ||
      ["transcribing", "preparing", "loading"].includes(status.phase)
    ) {
      this.showBusyNotice();
      return;
    }
    if (status.engine === "missing" || status.engine === "error") {
      this.asr.setActivity(
        "error",
        status.engine === "missing"
          ? "Set up the speech runtime before your first dictation"
          : "Repair the speech runtime or reload the speech model before starting another dictation",
      );
      this.setHud(
        status.engine === "missing"
          ? {
              state: "error",
              title: "Setup needed",
              detail: "Set up the speech runtime",
            }
          : {
              state: "error",
              title: "Unavailable",
              detail: "Open Delulu Talks",
            },
      );
      return;
    }
    const microphone = this.microphonePermission();
    if (!microphone.canRequestCapture) {
      this.asr.setActivity("error", microphone.detail);
      this.setHud({
        state: "error",
        title: "Microphone access blocked",
        detail: microphone.detail,
      });
      return;
    }
    if (!this.recorderReady) {
      this.asr.setActivity(
        "error",
        "The microphone controller is still starting — try again in a moment",
      );
      this.setHud({
        state: "error",
        title: "Not ready",
        detail: "Try again in a moment",
      });
      return;
    }
    const settings = structuredClone(this.settings());
    this.captureSettings = settings;
    this.captureSessionId = randomUUID();
    this.captureState = "opening";
    this.armDeadline(
      OPENING_DEADLINE_MS,
      "The microphone did not start. Try again or choose another input.",
    );
    this.asr.setCaptureInputNotice?.(null);
    this.asr.setSilenceCountdown?.(null);
    this.asr.setActivity("idle", "Opening microphone");
    this.sendRecorder({
      action: "start",
      inputDeviceId: settings.inputDeviceId,
      sessionId: this.captureSessionId,
      captureProfile: captureProfileSnapshot(settings),
      trailingSilence: settings.trailingSilenceStopEnabled
        ? {
            seconds: settings.trailingSilenceSeconds,
            thresholdDb: settings.trailingSilenceThresholdDb,
          }
        : null,
    });
  }

  stop(): void {
    this.asr.setSilenceCountdown?.(null);
    if (this.busyNotice) this.setHud({ state: "hidden" });
    if (this.captureState === "opening") {
      this.captureState = "stopping";
      this.asr.setActivity(
        "idle",
        "Shortcut released — closing the microphone",
      );
      return;
    }
    if (
      !["listening", "pausing", "paused", "resuming"].includes(
        this.captureState,
      )
    )
      return;
    this.captureState = "stopping";
    this.armDeadline(
      STOPPING_DEADLINE_MS,
      "The recording did not finish. Please dictate again.",
    );
    this.sendRecorder({
      action: "stop",
      inputDeviceId: this.settings().inputDeviceId,
      sessionId: this.captureSessionId!,
    });
  }

  /**
   * The renderer owns the microphone. If it never answers (crash, hang,
   * thrown handler), fail the capture instead of staying "recording" forever.
   */
  private armDeadline(milliseconds: number, message: string): void {
    this.clearDeadline();
    const sessionId = this.captureSessionId;
    this.deadline = setTimeout(() => {
      this.deadline = null;
      if (
        !sessionId ||
        sessionId !== this.captureSessionId ||
        !["opening", "stopping"].includes(this.captureState)
      )
        return;
      this.sendRecorder({
        action: "cancel",
        inputDeviceId: this.settings().inputDeviceId,
        sessionId,
      });
      this.failCapture(message);
    }, milliseconds);
    this.deadline.unref?.();
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  toggle(): void {
    if (
      ["opening", "listening", "pausing", "paused", "resuming"].includes(
        this.captureState,
      )
    )
      this.stop();
    else if (this.captureState === "idle") this.start();
  }

  pause(): void {
    if (this.captureState !== "listening") return;
    this.captureState = "pausing";
    this.sendRecorder({
      action: "pause",
      sessionId: this.captureSessionId ?? undefined,
      inputDeviceId: this.settings().inputDeviceId,
    });
  }

  resume(): void {
    if (this.captureState !== "paused") return;
    this.captureState = "resuming";
    this.sendRecorder({
      action: "resume",
      sessionId: this.captureSessionId ?? undefined,
      inputDeviceId: this.settings().inputDeviceId,
    });
  }

  recordingPauseChanged(sessionId: string, paused: boolean): void {
    if (
      sessionId !== this.captureSessionId ||
      this.captureState !== (paused ? "pausing" : "resuming")
    )
      return;
    this.captureState = paused ? "paused" : "listening";
    this.asr.setActivity(
      paused ? "paused" : "listening",
      paused
        ? "Paused — audio retained; microphone remains open. Resume or Stop to transcribe."
        : "Listening — resumed the same recording",
    );
    // The microphone stays open while paused, so the overlay stays visible.
    if (paused)
      this.setHud({
        state: "listening",
        title: "Paused",
        detail: "Microphone open · Resume or Stop",
      });
    else
      this.setHud({
        state: "listening",
        detail: "Resumed — Stop to transcribe",
      });
  }

  cancel(): void {
    this.asr.setSilenceCountdown?.(null);
    if (this.busyNotice) this.setHud({ state: "hidden" });
    if (this.captureState === "idle" || this.captureState === "processing")
      return;
    const sessionId = this.captureSessionId!;
    this.clearDeadline();
    this.captureState = "idle";
    this.captureSessionId = null;
    this.captureSettings = null;
    this.sendRecorder({
      action: "cancel",
      inputDeviceId: this.settings().inputDeviceId,
      sessionId,
    });
    this.setHud({ state: "hidden" });
    this.asr.setActivity("idle", "Recording cancelled");
  }

  recordingSilence(
    sessionId: string,
    remainingSeconds: number | null,
    stop: boolean,
  ): void {
    if (
      sessionId !== this.captureSessionId ||
      !["opening", "listening"].includes(this.captureState)
    )
      return;
    this.asr.setSilenceCountdown?.(remainingSeconds);
    if (!stop) {
      if (this.captureState === "listening") {
        const hold = this.settings().shortcutMode === "hold";
        this.setHud({
          state: "listening",
          detail:
            remainingSeconds === null
              ? hold
                ? "Release to send"
                : "Press shortcut to send"
              : `Auto-stop in ${remainingSeconds}s · Stop still available`,
        });
      }
      return;
    }
    this.stop();
    this.asr.setActivity("listening", "Trailing silence — finishing capture");
    this.setHud({
      state: "transcribing",
      title: "Finishing capture",
      detail: "Trailing silence",
    });
  }

  recordingLimitReached(sessionId: string): void {
    if (
      sessionId !== this.captureSessionId ||
      !ACTIVE_CAPTURE.includes(this.captureState)
    )
      return;
    // Use the same ownership transition as a user Stop so bounded audio is
    // accepted by the normal transcript/rewrite/delivery pipeline.
    this.stop();
    this.asr.setActivity(
      "listening",
      "Recording limit reached — finishing capture",
    );
    this.setHud({
      state: "transcribing",
      title: "Finishing capture",
      detail: "Recording limit reached",
    });
  }

  recordingStarted(sessionId: string): void {
    if (sessionId !== this.captureSessionId) return;
    if (this.captureState === "stopping") {
      this.asr.setActivity("listening", "Finishing capture");
      this.sendRecorder({
        action: "stop",
        inputDeviceId: this.settings().inputDeviceId,
        sessionId,
      });
      return;
    }
    if (this.captureState !== "opening") return;
    this.clearDeadline();
    this.captureState = "listening";
    const hold =
      (this.captureSettings ?? this.settings()).shortcutMode === "hold";
    this.asr.setActivity(
      "listening",
      hold
        ? "Listening — release the shortcut to transcribe"
        : "Listening — press the shortcut again to finish",
    );
    this.setHud({
      state: "listening",
      detail: hold ? "Release to send" : "Press shortcut to send",
    });
  }

  recordingInputChanged(
    sessionId: string,
    message: string,
    inputLost: boolean,
  ): void {
    if (
      sessionId !== this.captureSessionId ||
      !ACTIVE_CAPTURE.includes(this.captureState)
    )
      return;
    this.asr.setCaptureInputNotice?.(message);
    if (inputLost) this.stop();
  }

  recordingFailed(message: string, sessionId: string): void {
    if (
      sessionId !== this.captureSessionId ||
      this.captureState === "processing"
    )
      return;
    if (message.startsWith(TOO_SHORT)) {
      // A quick tap is not a microphone failure.
      this.clearDeadline();
      this.asr.setSilenceCountdown?.(null);
      this.captureState = "idle";
      this.captureSessionId = null;
      this.captureSettings = null;
      this.setHud({
        state: "error",
        title: "Too short",
        detail:
          this.settings().shortcutMode === "hold"
            ? "Hold the shortcut while you speak"
            : "Speak, then press the shortcut again",
      });
      this.asr.setActivity("idle", message);
      return;
    }
    this.failCapture(message);
  }

  private failCapture(message: string): void {
    this.clearDeadline();
    this.asr.setSilenceCountdown?.(null);
    this.captureState = "idle";
    this.captureSessionId = null;
    this.captureSettings = null;
    this.setHud({
      state: "error",
      title: "Could not finish",
      detail: /microphone|input|audio/i.test(message)
        ? "Check the microphone"
        : "Open Delulu Talks for details",
    });
    this.asr.setActivity("error", message);
  }

  async submitRecording(submission: RecordingSubmission): Promise<void> {
    if (
      !submission ||
      !Number.isFinite(submission.durationMs) ||
      submission.durationMs < 0
    )
      throw new Error("Invalid recording duration");
    // Cancellation/reload consumes the identity. A late callback cannot commit
    // audio into an idle or newer session, and duplicate submissions stay inert.
    // The renderer can finish on its own (recording limit, lost input, a pause
    // that never acknowledged); accept its audio in any active capture state.
    if (
      !(["stopping", ...ACTIVE_CAPTURE] as CaptureState[]).includes(
        this.captureState,
      ) ||
      !this.captureSessionId ||
      submission.sessionId !== this.captureSessionId
    )
      return;
    this.clearDeadline();
    this.captureSessionId = null;
    this.asr.setSilenceCountdown?.(null);
    await this.processRecording(submission);
  }

  private async processRecording(
    submission: RecordingSubmission,
    retryLease?: RetryAudioLease,
  ): Promise<boolean> {
    if (this.captureState === "processing")
      throw new Error("A recording is already being processed");
    this.captureState = "processing";
    const settings =
      this.captureSettings ??
      (retryLease ? this.retrySettings : null) ??
      this.settings();
    this.captureSettings = structuredClone(settings);
    if (
      !(submission.wav instanceof Uint8Array) ||
      submission.wav.byteLength < 44
    ) {
      this.failCapture("The microphone returned an empty recording");
      return false;
    }
    if (submission.wav.byteLength > 500 * 1024 * 1024) {
      this.failCapture(
        "Recording is too large; keep dictation captures below 500 MB",
      );
      return false;
    }
    if (submission.durationMs < 180) {
      this.captureState = "idle";
      this.setHud({
        state: "error",
        title: "Too short",
        detail: "Hold a little longer",
      });
      this.asr.setActivity("idle", "Recording was too short and was discarded");
      this.captureSettings = null;
      return true;
    }

    const audioPath = join(
      this.storage.cacheDirectory,
      `dictation-${Date.now()}-${randomUUID()}.wav`,
    );
    let deliveryStarted = false;
    const timings = normalizeTimings(submission.timings) ?? {};
    try {
      const preprocessingStarted = performance.now();
      mkdirSync(this.storage.cacheDirectory, { recursive: true });
      writeFileSync(audioPath, submission.wav, { mode: 0o600 });
      timings.preprocessingMs =
        (timings.preprocessingMs ?? 0) +
        performance.now() -
        preprocessingStarted;
      this.asr.setActivity("transcribing", "Transcribing locally");
      this.setHud({ state: "transcribing" });
      const result = await this.asr.transcribe(
        { audioPath, durationMs: submission.durationMs },
        settings,
      );
      if (typeof result.text === "string" && !result.text.trim())
        throw new NoSpeechError();
      this.retryAudio.clearAvailable();
      this.publishRetryAudio();
      let record = this.createRecord(
        result,
        "dictation",
        submission.durationMs,
        null,
        settings,
        timings,
      );
      record.captureDiagnostics = normalizeCaptureDiagnostics(
        submission.captureDiagnostics,
      );
      let output = this.outputText(record, settings);
      if (!output.trim()) {
        throw new Error(
          "Personalization returned no text. Review your saved rules and retry.",
        );
      }
      let magicFailure: string | null = null;
      if (
        settings.magicEnabled &&
        (!settings.dictationMode || settings.dictationMode === "prose")
      ) {
        this.asr.setActivity(
          "transcribing",
          settings.magicPreset === "spoken-corrections"
            ? "Resolving spoken corrections"
            : "Rewriting is polishing the transcript",
        );
        this.setHud({
          state: "magic",
          ...(settings.magicPreset === "spoken-corrections"
            ? {
                title: "Keeping your final words",
                detail: "Resolving spoken corrections",
              }
            : {}),
        });
        try {
          const magic = await this.asr.rewriteMagic(
            {
              text: output,
              sourceLanguage: record.language,
              preset: settings.magicPreset,
              allowInferences: settings.magicAllowInferences,
            },
            settings,
          );
          output = magic.text;
          record = {
            ...record,
            magicText: magic.text,
            rewriteSourceRevision: record.sourceRevision ?? 0,
            magicModel: magic.model,
            magicPreset: settings.magicPreset,
            magicIncludedInferences: magic.includedInferences,
            magicProcessingTimeMs: magic.processingTimeMs,
            timings: normalizeTimings({
              ...record.timings,
              ...normalizeTimings(magic.timings),
            }),
          };
        } catch (error) {
          magicFailure = (
            error instanceof Error ? error.message : String(error)
          )
            .split(/\r?\n/)[0]
            .slice(0, 180);
        }
      }
      record.sessionOnly =
        !settings.keepHistory || !this.storage.getSettings().keepHistory;
      if (magicFailure && settings.magicPreset === "spoken-corrections") {
        record.delivery = {
          state: "transcribed",
          updatedAt: Date.now(),
          detail: `Spoken corrections need review: ${magicFailure}. Nothing sent.`,
        };
      }
      this.storage.addHistory(record);
      this.broadcastTranscript(record);
      if (magicFailure && settings.magicPreset === "spoken-corrections") {
        this.setHud({
          state: "error",
          title: "Review your words",
          detail: "Original saved · nothing sent",
        });
        this.asr.setActivity(
          "idle",
          `Spoken corrections: ${magicFailure}. Original available in Latest output; nothing sent.`,
        );
        return true;
      }
      const outputName = record.magicText ? "Rewrite result" : "Transcript";
      let completion = `${outputName} ready in Latest output`;
      let delivery: "ready" | "pasted" | "copied" | "failed" = "ready";
      this.setHud({ state: "delivering" });
      deliveryStarted = true;
      if (settings.autoPaste) {
        try {
          const method = await this.paste.paste(
            output,
            settings.restoreClipboardAfterPaste,
            (record.timings ??= {}),
          );
          record = this.recordDelivery(
            record,
            "paste-attempted",
            "Paste command sent; destination receipt is not confirmed",
            method,
          );
          delivery = "pasted";
          completion = `${outputName}: paste attempted — destination unconfirmed`;
        } catch (error) {
          const detail = (
            error instanceof Error ? error.message : String(error)
          ).slice(0, 500);
          const copied = !(error instanceof ClipboardCopyError);
          this.reportPasteFailure(record.id, detail);
          delivery = copied ? "copied" : "failed";
          record = this.recordDelivery(
            record,
            copied ? "copied" : "transcribed",
            detail,
          );
          completion = copied
            ? `Copied — paste manually (${detail})`
            : `Transcribed — clipboard copy failed (${detail})`;
        }
      } else if (settings.copyToClipboard) {
        try {
          this.paste.copy(output, (record.timings ??= {}));
          delivery = "copied";
          record = this.recordDelivery(record, "copied");
          completion = `${outputName} copied to clipboard`;
        } catch (error) {
          const detail = (
            error instanceof Error ? error.message : String(error)
          ).slice(0, 500);
          delivery = "failed";
          record = this.recordDelivery(record, "transcribed", detail);
          completion = `Transcribed — clipboard copy failed (${detail})`;
        }
      }
      if (settings.autoPaste || settings.copyToClipboard)
        this.publishDeliveryTimings(record, output);
      if (magicFailure)
        completion = `${completion} · Rewriting unavailable: ${magicFailure}`;
      this.setHud({
        state: delivery === "failed" ? "error" : "success",
        title:
          record.delivery?.state === "paste-attempted"
            ? "Paste sent"
            : record.delivery?.state === "copied"
              ? "Copied"
              : "Transcribed",
        detail:
          record.delivery?.state === "paste-attempted"
            ? "Check your text at the cursor"
            : magicFailure
              ? "Rewriting skipped"
              : "Ready to keep talking",
      });
      this.asr.setActivity("idle", completion);
      return true;
    } catch (error) {
      if (error instanceof NoSpeechError && !retryLease) {
        // Silence is not a failure, and must not replace audio kept for retry.
        this.setHud({
          state: "error",
          title: "No speech detected",
          detail: "Nothing was typed",
        });
        this.asr.setActivity("idle", error.message);
        return false;
      }
      if (deliveryStarted) {
        this.retryAudio.discard();
        this.retrySettings = null;
      }
      const retained =
        !deliveryStarted && (retryLease || this.retryAudio.retain(submission));
      this.retrySettings = retained ? structuredClone(settings) : null;
      this.publishRetryAudio();
      this.setHud({ state: "error" });
      const cause = error instanceof Error ? error.message : String(error);
      this.asr.setActivity(
        "error",
        retained
          ? cause
          : `${cause} — This recording could not be retained for retry.`,
      );
      return false;
    } finally {
      this.captureState = "idle";
      this.captureSettings = null;
      try {
        rmSync(audioPath, { force: true });
      } catch (cleanupError) {
        // Windows can briefly lock the file; never let cleanup mask the result.
        console.error(
          "Could not remove temporary dictation audio",
          cleanupError,
        );
      }
    }
  }

  async runLab(
    request: LabRequest,
    signal?: AbortSignal,
  ): Promise<TranscriptRecord> {
    const checkCancellation = () => {
      if (signal?.aborted)
        throw new Error("Import cancelled; no transcript was saved.");
    };
    checkCancellation();
    if (this.isActive || this.asr.isBusy)
      throw new Error("Finish the current recording or model operation first");
    this.captureState = "processing";
    const settings = this.settings();
    this.asr.setActivity("transcribing", "Transcribing imported audio");
    let preparedAudio: { path: string; directory?: string } | null = null;
    let failure: unknown;
    try {
      const preprocessingStarted = performance.now();
      preparedAudio = await this.prepareAudio(request.path, signal);
      checkCancellation();
      const timings: PipelineTimings = {
        preprocessingMs: performance.now() - preprocessingStarted,
      };
      const payload = await this.asr.transcribe(
        { audioPath: preparedAudio.path },
        settings,
      );
      checkCancellation();
      const record = this.createRecord(
        payload,
        "file",
        undefined,
        basename(request.path),
        settings,
        timings,
      );
      record.sessionOnly =
        !settings.keepHistory || !this.storage.getSettings().keepHistory;
      this.storage.addHistory(record);
      this.broadcastTranscript(record);
      this.asr.setActivity("idle", "Speech Lab result ready");
      return record;
    } catch (error) {
      failure = error;
      this.asr.setActivity(
        signal?.aborted ? "idle" : "error",
        signal?.aborted
          ? "Import cancelled; no transcript was saved."
          : error instanceof Error
            ? error.message
            : String(error),
      );
      throw error;
    } finally {
      this.captureState = "idle";
      if (preparedAudio?.directory) {
        try {
          this.removeImportDirectory(preparedAudio.directory, failure);
        } catch (error) {
          this.asr.setActivity(
            "error",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
    }
  }

  private removeImportDirectory(directory: string, failure?: unknown): void {
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      const message = "Could not remove temporary converted audio after import";
      if (failure !== undefined)
        throw new AggregateError([failure, cleanupError], message, {
          cause: failure,
        });
      throw new Error(message, { cause: cleanupError });
    }
  }

  private async prepareAudio(
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; directory?: string }> {
    if (
      [".wav", ".flac", ".ogg", ".opus"].includes(
        extname(sourcePath).toLowerCase(),
      )
    ) {
      // Source files are read-only inference inputs, never cleanup targets.
      return { path: sourcePath };
    }

    mkdirSync(this.storage.cacheDirectory, { recursive: true });
    // mkdtemp creates an exclusively owned directory with owner-only access.
    const directory = mkdtempSync(join(this.storage.cacheDirectory, "import-"));
    const outputPath = join(directory, "audio.wav");
    try {
      await new Promise<void>((resolveConversion, reject) => {
        const child = spawn(
          "ffmpeg",
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-i",
            sourcePath,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            outputPath,
          ],
          { windowsHide: true },
        );
        const cancel = () => {
          child.kill();
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        let stderr = "";
        let spawnError: Error | null = null;
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
        });
        child.once("error", (error) => {
          spawnError = error;
        });
        // Wait for stdio/file handles to close before removing partial output.
        child.once("close", (code) => {
          signal?.removeEventListener("abort", cancel);
          if (signal?.aborted) {
            reject(new Error("Import cancelled"));
            return;
          }
          if (spawnError) {
            reject(
              new Error(
                `This format needs FFmpeg. Install ffmpeg and try again (${spawnError.message})`,
                { cause: spawnError },
              ),
            );
          } else if (code === 0) resolveConversion();
          else
            reject(
              new Error(
                `FFmpeg could not decode this media file: ${stderr.trim() || `exit code ${code}`}`,
              ),
            );
        });
      });
      return { path: outputPath, directory };
    } catch (error) {
      this.removeImportDirectory(directory, error);
      throw error;
    }
  }

  private createRecord(
    result: Record<string, unknown>,
    source: TranscriptRecord["source"],
    durationOverride: number | undefined,
    sourceName: string | null,
    settings: AppSettings,
    timings?: PipelineTimings,
  ): TranscriptRecord {
    if (typeof result.text !== "string")
      throw new Error("The speech worker returned an invalid text result.");
    const text = result.text.trim();
    if (!text)
      throw new Error(
        "The speech model returned no text. Check the recording and retry.",
      );
    const language =
      normalizeReportedLanguage(result.recognizedLanguage) ?? settings.language;
    const formatted = settings.spokenFormattingCommands
      ? formatSpokenCommands(text, settings.language)
      : text;
    const personalized = personalizeWithUsage(
      formatted,
      settings.customWords,
      language,
    );
    this.recordRuleUsage(personalized.counts);
    const durationMs =
      durationOverride ?? Math.round(numeric(result.duration) * 1000);
    const languageMetadata = normalizeLanguageMetadata(result);
    const backendTimings = normalizeTimings(result.timings);
    const mergedTimings = { ...timings, ...backendTimings };
    if (
      timings?.preprocessingMs !== undefined &&
      backendTimings?.preprocessingMs !== undefined
    ) {
      mergedTimings.preprocessingMs =
        timings.preprocessingMs + backendTimings.preprocessingMs;
    }
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      durationMs,
      text,
      dictationMode:
        source === "dictation" ? (settings.dictationMode ?? "prose") : "prose",
      technicalText:
        source === "dictation" &&
        (settings.dictationMode === "code" ||
          settings.dictationMode === "command")
          ? renderTechnicalDictation(text, settings.dictationMode)
          : null,
      sourceRevision: 0,
      rewriteSourceRevision: null,
      personalizedText:
        source === "dictation" && settings.dictationFormatting === "spoken"
          ? formatDictation(
              text,
              settings.customWords,
              settings.dictationFormatting,
              settings.language,
            )
          : personalized.text,
      dictationFormatting:
        source === "dictation" &&
        settings.dictationFormatting === "spoken" &&
        (settings.language === "en" || settings.language === "nl")
          ? "spoken"
          : "preserve",
      model: settings.model,
      language: languageMetadata.recognizedLanguage ?? "und",
      ...languageMetadata,
      requestedLanguage: settings.language,
      speechExecution: normalizeSpeechExecution(result.speechExecution),
      source,
      sourceName,
      processingTimeMs: Math.round(numeric(result.processingTime) * 1000),
      timings: normalizeTimings(mergedTimings),
      delivery: { state: "transcribed", updatedAt: Date.now() },
    };
  }

  private recordDelivery(
    record: TranscriptRecord,
    state: NonNullable<TranscriptRecord["delivery"]>["state"],
    detail?: string,
    method?: string,
  ): TranscriptRecord {
    const saved = this.storage.findHistory(record.id);
    const updated = {
      ...(saved ?? record),
      delivery: { state, updatedAt: Date.now(), detail, method },
    };
    if (saved) this.storage.replaceHistory(updated);
    this.broadcastTranscript(updated);
    return updated;
  }

  private publishDeliveryTimings(
    record: TranscriptRecord,
    output: string,
  ): void {
    try {
      const existing = this.storage.findHistory(record.id);
      if (existing && deliveredText(existing) !== output) return;
      const deliveryTimings: PipelineTimings = {};
      if (record.timings?.clipboardMs !== undefined)
        deliveryTimings.clipboardMs = record.timings.clipboardMs;
      if (record.timings?.pasteMs !== undefined)
        deliveryTimings.pasteMs = record.timings.pasteMs;
      const updated = {
        ...(existing ?? record),
        timings: normalizeTimings({
          ...(existing ?? record).timings,
          ...deliveryTimings,
        }),
      };
      try {
        if (existing) this.storage.replaceHistory(updated);
      } catch {
        // Timing metadata must not turn completed delivery into a failed recording.
      }
      this.broadcastTranscript(updated);
    } catch {
      // Delivery already completed; a metadata notification is best effort.
    }
  }

  private outputText(record: TranscriptRecord, settings: AppSettings): string {
    return deliveredText(record);
  }
}
