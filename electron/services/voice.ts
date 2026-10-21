import { randomUUID } from "node:crypto";
import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DomainError,
  domainError,
  serializeDomainError,
} from "../../src/domainErrors";
import { speakableText } from "../../src/speakableText";
import { parseVoiceMarkup } from "../../src/voiceMarkup";
import { planVoiceChunks, type VoiceChunk } from "../../src/voiceChunks";
import {
  VOICE_ENGINE_INFO,
  VOICE_LIMITS,
  type VoiceBridgeStatus,
  type VoiceEngineId,
  type VoicePlaybackChunk,
  type VoicePlaybackEvent,
  type VoiceQueued,
  type VoiceSource,
  type VoiceSpeakRequest,
  type VoiceSpeakResult,
  type VoiceStatus,
  type VoiceSynthesizeResult,
  type VoiceTimestamp,
  type VoiceUtteranceOutcome,
  type VoiceUtteranceSummary,
} from "../../src/voice";
import type { AppSettings, RuntimeSetupLog, SetupStage } from "../../src/types";
import { RuntimeInstaller } from "../runtime/installer";
import { runtimeEnvironment } from "../runtime/environment";
import { voiceRuntimeProfile } from "../runtime/platform";
import { WorkerClient } from "../runtime/workerClient";
import type { StorageService } from "./storage";

/** Renderer playback, owned by the main window. */
export type VoicePlayback = {
  /** Returns false when no renderer can play audio right now. */
  play(chunk: VoicePlaybackChunk): boolean;
  stop(utteranceId: string | null): void;
};

/** The worker surface the service uses; tests substitute a fake. */
export type VoiceWorker = Pick<
  WorkerClient,
  "request" | "stopAndWait" | "running" | "busy"
>;

type WorkerStatus = {
  loaded: boolean;
  model: string | null;
  device: string | null;
  residency?: "resident" | "unloaded";
  warmup?: "not-started" | "warming" | "complete" | "unknown";
  engine: VoiceEngineId | null;
};

type PendingChunk = {
  resolve: () => void;
  timer: NodeJS.Timeout;
};

type Utterance = {
  id: string;
  at: number;
  source: VoiceSource;
  agent: string | null;
  text: string;
  chunks: VoiceChunk[];
  warnings: string[];
  unsupported: Set<string>;
  timestamps: VoiceTimestamp[];
  cursorMs: number;
  /** Chunks the renderer reported as started and not yet ended. */
  playing: Set<number>;
  pending: Map<number, PendingChunk>;
  /** Highest chunk index the renderer has started. */
  heard: number;
  /** When the audio sent so far should have finished playing. */
  playEndAt: number;
  outcome: VoiceUtteranceOutcome;
  cancelled: boolean;
  error?: string;
  finish: (result: VoiceSpeakResult) => void;
  done: Promise<VoiceSpeakResult>;
};

const RECENT_LIMIT = 20;
/** Synthesize at most this many chunks ahead of the one being heard. */
const LOOKAHEAD = 2;
/** Fallback when the renderer never reports a chunk's end. */
const PLAYBACK_GRACE_MS = 4_000;

function modelSetupStage(stage: string): SetupStage | null {
  return (
    (
      {
        download: "model-download",
        load: "model-load",
        warmup: "warmup",
      } as Record<string, SetupStage>
    )[stage] ?? null
  );
}

function summary(text: string, limit = 280): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function voiceError(
  code: "INVALID_REQUEST" | "BUSY" | "WORKER_UNAVAILABLE",
  message: string,
  operation: string,
): DomainError {
  return new DomainError(code, message, {
    operationId: randomUUID(),
    operation,
  });
}

/**
 * Owns the voice runtime, its worker and the speech queue. Utterances are
 * spoken one at a time; each is split into chunks so the first sentence plays
 * while the next is synthesized.
 */
export class VoiceService {
  private readonly installer: RuntimeInstaller;
  private readonly worker: VoiceWorker;
  private readonly listeners = new Set<(status: VoiceStatus) => void>();
  private status: VoiceStatus;
  private queue: Utterance[] = [];
  private current: Utterance | null = null;
  private draining = false;
  private recent: VoiceUtteranceSummary[] = [];
  private setupOperation: {
    controller: AbortController;
    promise: Promise<void>;
    started: boolean;
  } | null = null;
  private loadPromise: Promise<void> | null = null;
  private unloadPromise: Promise<void> | null = null;
  private loadedEngine: VoiceEngineId | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private bridgeStatus: VoiceBridgeStatus = {
    enabled: false,
    listening: false,
    clients: 0,
    endpoint: null,
    error: null,
  };

  constructor(
    private readonly storage: StorageService,
    private readonly playback: VoicePlayback,
    private readonly overrides: {
      worker?: VoiceWorker;
      ready?: (settings: AppSettings) => Promise<boolean>;
    } = {},
  ) {
    this.status = {
      phase: "idle",
      engine: "missing",
      message: "Voice setup required",
      model: null,
      residency: "unloaded",
      warmup: "not-started",
      device: null,
      current: null,
      queued: 0,
      recent: [],
      bridge: this.bridgeStatus,
    };
    this.installer = new RuntimeInstaller(
      {
        dataDirectory: storage.dataDirectory,
        venvDirectory: storage.voiceVenvDirectory,
        kind: "voice",
      },
      null,
      () => this.environment(),
    );
    this.worker =
      overrides.worker ??
      new WorkerClient(
        () => ({
          python: this.installer.python,
          script: this.scriptPath(),
          env: this.environment(),
        }),
        (error) => {
          if (!this.setupOperation?.controller.signal.aborted) this.fail(error);
        },
        (detail, event) => {
          if (this.setupOperation?.controller.signal.aborted) return;
          if (event?.command !== "voiceLoad") return;
          const stage = modelSetupStage(event.stage);
          this.update({
            detail,
            ...(stage ? { setupStage: stage, progress: null } : {}),
            ...(event.stage === "warmup"
              ? { residency: "resident" as const, warmup: "warming" as const }
              : {}),
            downloadBytes: event.downloadBytes ?? null,
          });
        },
      );
  }

  /* -------------------------------------------------------------- */
  /* Status                                                          */
  /* -------------------------------------------------------------- */

  onStatus(listener: (status: VoiceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): VoiceStatus {
    return structuredClone(this.status);
  }

  getSetupLog(): RuntimeSetupLog {
    return this.installer.setupLog.snapshot("voice");
  }

  get isSpeaking(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  get isBusy(): boolean {
    return (
      !!this.setupOperation ||
      !!this.loadPromise ||
      this.worker.busy ||
      this.isSpeaking
    );
  }

  setBridgeStatus(bridge: VoiceBridgeStatus): void {
    this.bridgeStatus = bridge;
    this.update({});
  }

  private update(patch: Partial<VoiceStatus>): void {
    if (patch.engine && patch.engine !== "error")
      patch = { ...patch, failure: null };
    const current = this.current;
    const heard = current
      ? Math.min(current.chunks.length, Math.max(1, current.heard + 1))
      : 0;
    this.status = {
      ...this.status,
      ...(patch.engine === "unloaded" || patch.engine === "missing"
        ? {
            residency: "unloaded" as const,
            warmup: "not-started" as const,
            device: null,
            model: null,
            setupStage: null,
          }
        : {}),
      ...patch,
      phase: current
        ? current.playing.size
          ? "speaking"
          : "synthesizing"
        : "idle",
      current: current
        ? {
            id: current.id,
            text: summary(current.text),
            source: current.source,
            agent: current.agent,
            chunk: heard,
            chunks: current.chunks.length,
          }
        : null,
      queued: this.queue.length,
      recent: this.recent,
      bridge: this.bridgeStatus,
    };
    if (!["settingUp", "loading"].includes(this.status.engine))
      this.status.downloadBytes = null;
    const snapshot = this.getStatus();
    for (const listener of this.listeners) listener(snapshot);
  }

  /* -------------------------------------------------------------- */
  /* Runtime                                                         */
  /* -------------------------------------------------------------- */

  private scriptPath(): string {
    const packaged = join(
      process.resourcesPath,
      "python",
      "transcription_engine.py",
    );
    if (app.isPackaged && existsSync(packaged)) return packaged;
    return resolve(
      app.getAppPath(),
      "electron",
      "python",
      "transcription_engine.py",
    );
  }

  private environment(): NodeJS.ProcessEnv {
    let bin = join(
      this.storage.voiceVenvDirectory,
      process.platform === "win32" ? "Scripts" : "bin",
    );
    try {
      bin = dirname(this.installer.python);
    } catch {
      /* Repair must still run when the old activation record is damaged. */
    }
    return {
      ...runtimeEnvironment(
        "voice",
        this.storage.dataDirectory,
        this.storage.modelCacheDirectory,
        bin,
      ),
      TQDM_DISABLE: "1",
    };
  }

  private profile(settings: AppSettings) {
    return voiceRuntimeProfile(settings.voiceEngine);
  }

  async isEnvironmentReady(settings: AppSettings): Promise<boolean> {
    if (this.overrides.ready) return this.overrides.ready(settings);
    return this.installer.ready("voice", this.profile(settings));
  }

  private runtimeInstalled(): boolean {
    try {
      return existsSync(this.installer.python);
    } catch {
      return false;
    }
  }

  async initialize(settings: AppSettings): Promise<void> {
    this.shuttingDown = false;
    this.update({
      engine: "unloaded",
      message: "Checking your voice runtime…",
    });
    const ready = await this.isEnvironmentReady(settings);
    if (this.setupOperation) return;
    this.update(
      ready
        ? {
            engine: "unloaded",
            message: "Voice ready — the model loads when something is said",
            migrationRequired: false,
          }
        : {
            engine: "missing",
            message: this.runtimeInstalled()
              ? `Voice runtime update required for ${VOICE_ENGINE_INFO[settings.voiceEngine].name}`
              : "Voice setup required",
            migrationRequired: this.runtimeInstalled(),
          },
    );
    if (ready && settings.voiceEnabled && settings.voiceKeepLoaded)
      void this.load(settings).catch((error) => this.fail(error));
  }

  /** Re-check the runtime after the engine changes, so setup is offered when needed. */
  async refreshEnvironment(settings: AppSettings): Promise<void> {
    if (this.setupOperation || this.shuttingDown) return;
    const ready = await this.isEnvironmentReady(settings);
    if (this.setupOperation || this.shuttingDown) return;
    if (!ready)
      this.update({
        engine: "missing",
        message: this.runtimeInstalled()
          ? `Voice runtime update required for ${VOICE_ENGINE_INFO[settings.voiceEngine].name}`
          : "Voice setup required",
        migrationRequired: this.runtimeInstalled(),
        progress: null,
      });
    else if (this.status.engine === "missing")
      this.update({
        engine: "unloaded",
        message: "Voice ready — the model loads when something is said",
        migrationRequired: false,
      });
  }

  async setup(settings: AppSettings): Promise<void> {
    if (this.setupOperation) return this.setupOperation.promise;
    const operation = {
      controller: new AbortController(),
      started: false,
      promise: Promise.resolve(),
    };
    this.setupOperation = operation;
    operation.promise = this.setupRuntime(settings, operation).finally(() => {
      if (this.setupOperation === operation) this.setupOperation = null;
      this.scheduleIdle();
    });
    return operation.promise;
  }

  async cancelSetup(): Promise<void> {
    const operation = this.setupOperation;
    if (!operation) return;
    operation.controller.abort(new Error("Voice setup cancelled"));
    this.update({
      setupState: "cancelling",
      message: "Cancelling voice setup — releasing runtime resources…",
      progress: null,
    });
    if (operation.started)
      await Promise.all([
        this.installer.stopAndWait(),
        this.worker.stopAndWait(),
      ]);
    await operation.promise.catch(() => undefined);
  }

  private async setupRuntime(
    settings: AppSettings,
    operation: NonNullable<VoiceService["setupOperation"]>,
  ): Promise<void> {
    const signal = operation.controller.signal;
    this.shuttingDown = false;
    this.stop("setup");
    this.installer.setupLog.begin("voice");
    this.installer.recordSetupStage("Preparing owned voice runtime candidate");
    this.update({
      setupState: "running",
      engine: "settingUp",
      message: "Preparing voice setup",
      progress: null,
    });
    try {
      signal.throwIfAborted();
      operation.started = true;
      await this.worker.stopAndWait();
      this.loadedEngine = null;
      this.update({
        residency: "unloaded",
        warmup: "not-started",
        device: null,
      });
      signal.throwIfAborted();
      await this.installer.install(
        "voice",
        settings,
        (progress) => {
          if (signal.aborted) return;
          this.update({ engine: "settingUp", ...progress });
        },
        { signal, deferActivation: true },
      );
      signal.throwIfAborted();
      // The candidate stays private to this worker until real warmup succeeds.
      const runtime = await this.loadWorker(settings);
      signal.throwIfAborted();
      if (!runtime.loaded || runtime.warmup !== "complete")
        throw new Error(
          "Voice warmup did not complete; the previous runtime remains selected",
        );
      this.installer.commit();
      this.installer.setupLog.finish(
        this.installer.setupLog.activeId,
        "success",
        "Voice runtime activated after a test sentence",
      );
      this.update({
        engine: "ready",
        setupStage: "ready",
        setupState: "complete",
        message: `${VOICE_ENGINE_INFO[settings.voiceEngine].name} is ready`,
        detail: null,
        progress: 1,
        migrationRequired: false,
      });
    } catch (error) {
      if (operation.started) {
        await Promise.all([
          this.installer.stopAndWait(),
          this.worker.stopAndWait(),
        ]);
        this.installer.discard();
        this.installer.resetCancellation();
        this.loadedEngine = null;
      }
      this.installer.setupLog.finish(
        this.installer.setupLog.activeId,
        signal.aborted ? "cancelled" : "error",
        signal.aborted
          ? "Setup cancelled; previous runtime preserved"
          : "Setup failed; previous runtime preserved",
      );
      if (signal.aborted) {
        this.update({
          engine: this.runtimeInstalled() ? "unloaded" : "missing",
          setupState: "cancelled",
          message: this.runtimeInstalled()
            ? "Setup cancelled. Your previous voice runtime is preserved."
            : "Setup cancelled. Voice setup is still required.",
          detail: null,
          progress: null,
        });
        return;
      }
      this.fail(error);
      this.update({ setupState: "failed" });
      throw error;
    }
  }

  /** Load the engine in the worker and wait for its warmup. */
  private async loadWorker(settings: AppSettings): Promise<WorkerStatus> {
    const engine = settings.voiceEngine;
    this.update({
      engine: "loading",
      message: `Loading ${VOICE_ENGINE_INFO[engine].name}…`,
      setupStage: "model-prepare",
      progress: null,
    });
    const status = await this.worker.request<WorkerStatus>("voiceLoad", {
      engine,
      cacheDir: this.storage.modelCacheDirectory,
    });
    this.loadedEngine = engine;
    this.update({
      engine: "ready",
      model: engine,
      residency: status.residency ?? "resident",
      warmup: status.warmup ?? "complete",
      device: status.device,
      setupStage: "model-loaded",
      message: `${VOICE_ENGINE_INFO[engine].name} is ready${status.device ? ` on the ${status.device.toUpperCase()}` : ""}`,
      detail: null,
      progress: null,
    });
    return status;
  }

  async load(
    settings: AppSettings = this.storage.getSettings(),
  ): Promise<void> {
    if (this.setupOperation)
      throw voiceError("BUSY", "Voice setup is still running", "voice:load");
    // Speech arriving during an unload waits for it, then loads again.
    await this.unloadPromise;
    if (
      this.loadedEngine === settings.voiceEngine &&
      this.status.engine === "ready" &&
      this.worker.running
    )
      return;
    if (this.loadPromise) {
      await this.loadPromise;
      if (this.loadedEngine === settings.voiceEngine) return;
    }
    const load = (async () => {
      if (!(await this.isEnvironmentReady(settings))) {
        await this.refreshEnvironment(settings);
        throw voiceError(
          "WORKER_UNAVAILABLE",
          `Set up ${VOICE_ENGINE_INFO[settings.voiceEngine].name} on the Voice page first.`,
          "voice:load",
        );
      }
      if (this.loadedEngine && this.loadedEngine !== settings.voiceEngine)
        await this.worker.request("voiceUnload");
      await this.loadWorker(settings);
    })();
    this.loadPromise = load;
    try {
      await load;
      if (!this.isSpeaking) this.scheduleIdle();
    } catch (error) {
      if (!(
        error instanceof DomainError && error.code === "WORKER_UNAVAILABLE"
      ))
        this.fail(error);
      throw error;
    } finally {
      if (this.loadPromise === load) this.loadPromise = null;
    }
  }

  async unload(): Promise<void> {
    if (this.unloadPromise) return this.unloadPromise;
    this.clearIdle();
    this.stop("unload");
    // Mark it unloaded before the first await so load() cannot take the fast path.
    this.loadedEngine = null;
    const unload = (async () => {
      await this.loadPromise?.catch(() => undefined);
      this.loadedEngine = null;
      if (this.worker.running)
        await this.worker
          .request("voiceUnload")
          .catch(() => undefined)
          .finally(() => this.worker.stopAndWait());
      if (this.status.engine !== "missing")
        this.update({
          engine: "unloaded",
          message: "Voice model unloaded — it loads when something is said",
        });
    })();
    this.unloadPromise = unload;
    try {
      await unload;
    } finally {
      this.unloadPromise = null;
    }
  }

  /** Apply saved settings: engine switches, residency and turning voice off. */
  async settingsChanged(
    previous: AppSettings,
    next: AppSettings,
  ): Promise<void> {
    if (!next.voiceEnabled && previous.voiceEnabled) this.stop("disabled");
    if (next.voiceEngine !== previous.voiceEngine) {
      await this.unload();
      await this.refreshEnvironment(next);
    }
    if (
      next.voiceEngine !== previous.voiceEngine ||
      next.voiceKeepLoaded !== previous.voiceKeepLoaded ||
      next.voiceEnabled !== previous.voiceEnabled ||
      next.modelIdleMinutes !== previous.modelIdleMinutes
    ) {
      if (
        next.voiceEnabled &&
        next.voiceKeepLoaded &&
        this.status.engine === "unloaded"
      )
        void this.load(next).catch(() => undefined);
      else this.scheduleIdle();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.status.idleUnloadAt) this.update({ idleUnloadAt: null });
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const settings = this.storage.getSettings();
    if (
      this.shuttingDown ||
      this.status.engine !== "ready" ||
      (settings.voiceEnabled && settings.voiceKeepLoaded)
    )
      return;
    const delay = settings.modelIdleMinutes * 60_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isBusy) return this.scheduleIdle();
      void this.unload().catch(() => undefined);
    }, delay);
    this.idleTimer.unref?.();
    this.update({ idleUnloadAt: Date.now() + delay });
  }

  fail(error: unknown): void {
    if (error instanceof DomainError && error.cancelled) return;
    this.clearIdle();
    this.loadedEngine = null;
    const failure = domainError(error, {
      operationId: randomUUID(),
      operation: "runtime:voice",
    });
    this.update({
      engine: "error",
      residency: this.worker.running ? "unknown" : "unloaded",
      warmup: this.worker.running ? "unknown" : "not-started",
      device: null,
      message: failure.message.split(/\r?\n/)[0].slice(0, 400),
      detail: failure.message,
      progress: null,
      failure: serializeDomainError(failure),
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearIdle();
    this.stop("shutdown");
    this.setupOperation?.controller.abort();
    await Promise.all([
      this.installer.stopAndWait().catch(() => undefined),
      // Never start a worker just to shut it down.
      this.worker.running
        ? this.worker
            .request("shutdown", {}, 5_000)
            .catch(() => undefined)
            .finally(() => this.worker.stopAndWait())
        : Promise.resolve(),
    ]);
  }

  /* -------------------------------------------------------------- */
  /* Speaking                                                        */
  /* -------------------------------------------------------------- */

  /** Queue an utterance; `done` resolves when it is spoken, stopped or failed. */
  enqueue(request: VoiceSpeakRequest): VoiceQueued & {
    done: Promise<VoiceSpeakResult>;
  } {
    const settings = this.storage.getSettings();
    const source = request.source ?? "app";
    const operation = `voice:speak:${source}`;
    if (this.shuttingDown)
      throw voiceError("WORKER_UNAVAILABLE", "Delulu is quitting", operation);
    if (source !== "app" && !settings.voiceEnabled)
      throw voiceError(
        "WORKER_UNAVAILABLE",
        "Speaking out loud is turned off in Delulu Talks. Turn it on in Voice.",
        operation,
      );
    if (this.status.engine === "missing" || this.setupOperation)
      throw voiceError(
        "WORKER_UNAVAILABLE",
        `Set up ${VOICE_ENGINE_INFO[settings.voiceEngine].name} on the Voice page first.`,
        operation,
      );
    if (typeof request.text !== "string")
      throw voiceError("INVALID_REQUEST", "Text is required", operation);
    if (request.text.length > VOICE_LIMITS.requestCharacters)
      throw voiceError(
        "INVALID_REQUEST",
        `Text is limited to ${VOICE_LIMITS.requestCharacters.toLocaleString("en")} characters`,
        operation,
      );
    const normalize = request.normalize ?? settings.voiceNormalizeText;
    const markup = parseVoiceMarkup(
      normalize ? speakableText(request.text) : request.text,
    );
    const chunks = planVoiceChunks(markup.segments);
    if (!chunks.length)
      throw voiceError("INVALID_REQUEST", "There is nothing to say", operation);
    if (request.interrupt) this.stop("interrupted");
    if (this.queue.length >= VOICE_LIMITS.queue)
      throw voiceError(
        "BUSY",
        `${VOICE_LIMITS.queue} messages are already waiting to be spoken`,
        operation,
      );
    let finish!: (result: VoiceSpeakResult) => void;
    const done = new Promise<VoiceSpeakResult>((resolve) => {
      finish = resolve;
    });
    const utterance: Utterance = {
      id: randomUUID(),
      at: Date.now(),
      source,
      agent: request.agent?.trim().slice(0, 64) || null,
      text: markup.plainText,
      chunks,
      warnings: markup.warnings.slice(0, 20),
      unsupported: new Set(),
      timestamps: [],
      cursorMs: 0,
      playing: new Set(),
      pending: new Map(),
      heard: -1,
      playEndAt: 0,
      outcome: "queued",
      cancelled: false,
      finish,
      done,
    };
    this.queue.push(utterance);
    // 0 means it starts right away; otherwise how many are ahead of it.
    const position = this.queue.length - 1 + (this.current ? 1 : 0);
    this.clearIdle();
    this.update({});
    void this.drain();
    return { id: utterance.id, position, done };
  }

  async speak(request: VoiceSpeakRequest): Promise<VoiceSpeakResult> {
    return this.enqueue(request).done;
  }

  /** Stop speaking and clear everything waiting. */
  stop(_reason = "user"): void {
    const stopped = [...(this.current ? [this.current] : []), ...this.queue];
    this.queue = [];
    if (!stopped.length) return;
    for (const utterance of stopped) {
      utterance.cancelled = true;
      for (const [, pending] of utterance.pending) {
        clearTimeout(pending.timer);
        pending.resolve();
      }
      utterance.pending.clear();
      utterance.playing.clear();
      if (utterance !== this.current) this.complete(utterance, "stopped");
    }
    this.playback.stop(null);
    this.update({});
  }

  /** Dictation started: stop talking so the user can answer. */
  interruptForDictation(): void {
    if (this.storage.getSettings().voiceInterruptOnDictation && this.isSpeaking)
      this.stop("dictation");
  }

  /** The renderer reloaded or went away; nothing it was playing will finish. */
  playbackLost(): void {
    for (const utterance of this.current ? [this.current] : []) {
      for (const [, pending] of utterance.pending) {
        clearTimeout(pending.timer);
        pending.resolve();
      }
      utterance.pending.clear();
      utterance.playing.clear();
    }
    this.update({});
  }

  playbackEvent(event: VoicePlaybackEvent): void {
    const utterance = this.current;
    if (!utterance || utterance.id !== event.utteranceId) return;
    if (event.event === "started") {
      utterance.playing.add(event.chunk);
      utterance.heard = Math.max(utterance.heard, event.chunk);
    } else {
      utterance.playing.delete(event.chunk);
      if (event.event === "failed" && !utterance.error)
        utterance.error = event.message?.slice(0, 400) || "Playback failed";
      const pending = utterance.pending.get(event.chunk);
      if (pending) {
        clearTimeout(pending.timer);
        utterance.pending.delete(event.chunk);
        pending.resolve();
      }
    }
    this.update({});
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.shuttingDown) {
        const utterance = this.queue.shift()!;
        this.current = utterance;
        utterance.outcome = "speaking";
        this.update({});
        await this.perform(utterance);
        this.current = null;
        this.update({});
      }
    } finally {
      this.draining = false;
      this.scheduleIdle();
    }
  }

  private async perform(utterance: Utterance): Promise<void> {
    const playbacks: Promise<void>[] = [];
    try {
      await this.load(this.storage.getSettings());
      for (let index = 0; index < utterance.chunks.length; index++) {
        if (utterance.cancelled) break;
        // Stay a short way ahead of what is being heard.
        if (index >= LOOKAHEAD) await playbacks[index - LOOKAHEAD];
        if (utterance.cancelled) break;
        const chunk = utterance.chunks[index];
        const live = this.storage.getSettings();
        const result = await this.worker.request<VoiceSynthesizeResult>(
          "voiceSynthesize",
          {
            engine: live.voiceEngine,
            voice: live.voiceName,
            ...(live.voiceEngine === "chatterbox-turbo" && live.voiceClone
              ? {
                  reference: join(
                    this.storage.voiceDirectory,
                    "references",
                    live.voiceClone,
                  ),
                }
              : {}),
            speed: live.voiceSpeed,
            styles: chunk.styles,
            parts: chunk.parts,
          },
        );
        if (utterance.cancelled) break;
        for (const tag of result.unsupported) utterance.unsupported.add(tag);
        utterance.timestamps.push({
          text: chunk.text,
          startMs: Math.round(utterance.cursorMs),
          endMs: Math.round(utterance.cursorMs + result.durationMs),
        });
        utterance.cursorMs += result.durationMs;
        playbacks.push(this.play(utterance, index, result));
        this.update({});
      }
      await Promise.all(playbacks);
      this.complete(
        utterance,
        utterance.cancelled ? "stopped" : utterance.error ? "failed" : "spoken",
      );
    } catch (error) {
      if (!utterance.cancelled) {
        utterance.error =
          error instanceof Error ? error.message : "Speech failed";
        this.playback.stop(utterance.id);
      }
      this.complete(utterance, utterance.cancelled ? "stopped" : "failed");
    }
  }

  private play(
    utterance: Utterance,
    index: number,
    result: VoiceSynthesizeResult,
  ): Promise<void> {
    const settings = this.storage.getSettings();
    // Chunks play back to back, so this one ends after everything sent before it.
    utterance.playEndAt =
      Math.max(Date.now(), utterance.playEndAt) + result.durationMs;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          utterance.pending.delete(index);
          utterance.playing.delete(index);
          resolve();
        },
        utterance.playEndAt - Date.now() + PLAYBACK_GRACE_MS,
      );
      timer.unref?.();
      utterance.pending.set(index, { resolve, timer });
      const delivered = this.playback.play({
        utteranceId: utterance.id,
        chunk: index,
        last: index === utterance.chunks.length - 1,
        sampleRate: result.sampleRate,
        pcm: Buffer.from(result.audio, "base64"),
        volume: settings.voiceVolume,
        outputDeviceId: settings.voiceOutputDeviceId,
      });
      if (!delivered) {
        clearTimeout(timer);
        utterance.pending.delete(index);
        utterance.error =
          "Open Delulu Talks once so it can play audio, then try again.";
        resolve();
      }
    });
  }

  private complete(
    utterance: Utterance,
    outcome: Exclude<VoiceUtteranceOutcome, "queued" | "speaking">,
  ): void {
    if (["spoken", "stopped", "failed"].includes(utterance.outcome)) return;
    utterance.outcome = outcome;
    const durationMs = Math.round(utterance.cursorMs);
    this.recent = [
      {
        id: utterance.id,
        at: utterance.at,
        source: utterance.source,
        agent: utterance.agent,
        text: summary(utterance.text, 400),
        outcome,
        durationMs,
      },
      ...this.recent,
    ].slice(0, RECENT_LIMIT);
    utterance.finish({
      id: utterance.id,
      outcome,
      durationMs,
      timestamps: utterance.timestamps,
      warnings: utterance.warnings,
      unsupported: [...utterance.unsupported],
      ...(utterance.error && outcome === "failed"
        ? { error: utterance.error }
        : {}),
    });
    this.update({});
  }
}
