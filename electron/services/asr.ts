import { splitForRewrite } from "../../src/personalization";
import { app } from "electron";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { magicModelById, modelById } from "../../src/data";
import type {
  AppSettings,
  BackendCapabilities,
  DictationStatus,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
  RuntimeLifecycle,
  RuntimeSetupKind,
  RuntimeSetupLog,
  RetryAudioState,
} from "../../src/types";
import type { StorageService } from "./storage";

import { WorkerClient, transcriptionTimeout } from "../runtime/workerClient";
import { SerialQueue } from "../runtime/serialQueue";
import { RuntimeInstaller } from "../runtime/installer";
import { runtimeEnvironment } from "../runtime/environment";
import { speechModelForPlatform } from "../runtime/platform";
import { privateFailureLog } from "../runtime/privateDiagnostics";

type WorkerRuntime = {
  loaded: boolean;
  residency?: RuntimeLifecycle["residency"];
  warmup?: RuntimeLifecycle["warmup"];
  device?: string | null;
};

const UNLOADED_LIFECYCLE: RuntimeLifecycle = {
  residency: "unloaded",
  warmup: "not-started",
  device: null,
  idleUnloadAt: null,
  capabilities: null,
};

function reportedLifecycle(runtime: Partial<WorkerRuntime>): RuntimeLifecycle {
  return {
    residency: runtime.residency ?? "unknown",
    warmup: runtime.warmup ?? "unknown",
    device: runtime.device ?? null,
  };
}

function failedLifecycle(running: boolean): RuntimeLifecycle {
  return running
    ? { residency: "unknown", warmup: "unknown", device: null, idleUnloadAt: null, capabilities: null }
    : UNLOADED_LIFECYCLE;
}

function setupCause(error: unknown, depth = 0): string {
  if (depth > 4) return "Additional nested causes omitted";
  const message = error instanceof Error
    ? `${error.name}: ${error.message.slice(0, 2048)}`
    : String(error).slice(0, 2048);
  if (error instanceof AggregateError)
    return `${message}\n${error.errors.slice(0, 4).map((cause) => setupCause(cause, depth + 1)).join("\n")}`;
  if (error instanceof Error && error.cause !== undefined)
    return `${message}\nCaused by: ${setupCause(error.cause, depth + 1)}`;
  return message;
}

function conciseError(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const useful = lines.filter(
    (line) =>
      !line.includes("unauthenticated requests") &&
      !line.includes("Loading weights") &&
      !/^\d+%\|/.test(line),
  );
  return (
    useful.at(-1) ??
    lines.at(-1) ??
    "The model worker stopped unexpectedly"
  ).slice(0, 800);
}

class SetupRollbackError extends Error {
  constructor(setupError: unknown, rollbackError: unknown) {
    const message = (error: unknown) =>
      conciseError(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 200);
    super(
      `The previous runtime could not be restored. Fix the filesystem error, then retry Repair. Setup failure: ${message(setupError)}. Rollback failure: ${message(rollbackError)}.`,
      {
        cause: new AggregateError(
          [setupError, rollbackError],
          "Setup and rollback failed",
        ),
      },
    );
    this.name = "SetupRollbackError";
  }
}

export class AsrService {
  private readonly speechWorker: WorkerClient;
  private readonly magicWorker: WorkerClient;
  private readonly speechInstaller: RuntimeInstaller;
  private readonly magicInstaller: RuntimeInstaller;
  private readonly maintenance = new SerialQueue();
  private readonly modelOperations = new SerialQueue();
  private initializing = false;
  get isBusy(): boolean {
    return (
      this.initializing ||
      this.maintenance.busy ||
      this.modelOperations.busy ||
      this.speechWorker.busy ||
      this.magicWorker.busy ||
      !!this.loadPromise ||
      !!this.magicLoadPromise ||
      !!this.speechUnloadPromise ||
      !!this.magicUnloadPromise ||
      this.speechOperations > 0 ||
      this.magicOperations > 0
    );
  }
  private status: DictationStatus = {
    ...UNLOADED_LIFECYCLE,
    speechModel: speechModelForPlatform(),
    phase: "idle",
    engine: "missing",
    message: "Speech runtime setup required",
    progress: null,
    retryAvailable: false,
    retryAudio: {
      phase: "empty",
      byteLength: 0,
      durationMs: null,
      discarded: false,
      sessionOnly: true,
    },
  };
  private statusListeners = new Set<(status: DictationStatus) => void>();
  private magicStatus: MagicStatus = {
    ...UNLOADED_LIFECYCLE,
    phase: "idle",
    engine: "missing",
    message: "Rewrite runtime setup required",
    progress: null,
  };
  private magicStatusListeners = new Set<(status: MagicStatus) => void>();
  private setupPromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;
  private magicSetupPromise: Promise<void> | null = null;
  private magicLoadPromise: Promise<void> | null = null;
  private speechUnloadPromise: Promise<void> | null = null;
  private magicUnloadPromise: Promise<void> | null = null;
  private speechOperations = 0;
  private magicOperations = 0;
  private shuttingDown = false;
  private residencyPending = false;
  private speechFailureGeneration = 0;
  private magicFailureGeneration = 0;
  private speechIdleTimer: NodeJS.Timeout | null = null;
  private magicIdleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly canIdleUnload: () => boolean = () => true,
  ) {
    const magicConstraints = app.isPackaged
      ? join(process.resourcesPath, "python/constraints-linux-x64.txt")
      : resolve(app.getAppPath(), "electron/python/constraints-linux-x64.txt");
    this.speechInstaller = new RuntimeInstaller(
      {
        dataDirectory: storage.dataDirectory,
        venvDirectory: storage.venvDirectory,
        kind: "speech",
      },
      null,
      () => this.workerEnvironment("speech"),
    );
    this.magicInstaller = new RuntimeInstaller(
      {
        dataDirectory: storage.dataDirectory,
        venvDirectory: storage.magicVenvDirectory,
        kind: "magic",
      },
      magicConstraints,
      () => this.workerEnvironment("magic"),
    );
    this.speechWorker = new WorkerClient(
      () => ({
        python: this.speechInstaller.python,
        script: this.scriptPath(),
        env: this.workerEnvironment("speech"),
      }),
      (error) => this.fail(error),
      (detail, event) => this.updateStatus({
        detail,
        ...(event?.command === "load" && event.stage === "warmup"
          ? { residency: "resident" as const, warmup: "warming" as const }
          : {}),
      }),
    );
    this.magicWorker = new WorkerClient(
      () => ({
        python: this.magicInstaller.python,
        script: this.scriptPath(),
        env: this.workerEnvironment("magic"),
      }),
      (error) => this.failMagic(error),
      (detail) => this.updateMagicStatus({ detail }),
    );
  }

  onStatus(listener: (status: DictationStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getSetupLog(kind: RuntimeSetupKind): RuntimeSetupLog {
    return (kind === "speech" ? this.speechInstaller : this.magicInstaller)
      .setupLog.snapshot(kind);
  }

  getStatus(): DictationStatus {
    return structuredClone(this.status);
  }

  onMagicStatus(listener: (status: MagicStatus) => void): () => void {
    this.magicStatusListeners.add(listener);
    return () => this.magicStatusListeners.delete(listener);
  }

  getMagicStatus(): MagicStatus {
    return structuredClone(this.magicStatus);
  }

  setRecovery(available: boolean, retryAudio?: RetryAudioState): void {
    this.updateStatus({ retryAvailable: available, retryAudio });
  }

  setCaptureInputNotice(message: string | null): void {
    this.updateStatus({ captureInputNotice: message });
  }

  setActivity(
    phase: DictationStatus["phase"],
    message: string,
    detail?: string,
  ): void {
    this.updateStatus({ phase, message, detail: detail ?? null });
  }

  private updateStatus(patch: Partial<DictationStatus>): void {
    this.status = {
      ...this.status,
      ...(patch.engine === "unloaded" || patch.engine === "missing"
        ? UNLOADED_LIFECYCLE : {}),
      ...patch,
    };
    for (const listener of this.statusListeners) listener(this.getStatus());
  }

  private updateMagicStatus(patch: Partial<MagicStatus>): void {
    this.magicStatus = {
      ...this.magicStatus,
      ...(patch.engine === "unloaded" || patch.engine === "missing"
        ? UNLOADED_LIFECYCLE : {}),
      ...patch,
    };
    for (const listener of this.magicStatusListeners)
      listener(this.getMagicStatus());
  }

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

  private venvPython(): string {
    return this.speechInstaller.python;
  }

  async initialize(settings: AppSettings): Promise<void> {
    this.shuttingDown = false;
    this.initializing = true;
    this.updateStatus({
      phase: "loading",
      engine: "unloaded",
      message: "Checking your speech runtime…",
    });
    this.updateMagicStatus({
      phase: "loading",
      engine: "unloaded",
      message: "Checking your rewrite runtime…",
    });
    const [ready, magicReady] = await Promise.all([
      this.isEnvironmentReady(),
      this.isMagicEnvironmentReady(),
    ]);
    const migrationRequired =
      !ready && existsSync(this.storage.legacyVenvDirectory);
    this.initializing = false;
    if (this.maintenance.busy) return;
    this.updateStatus(
      ready
        ? {
            phase: "idle",
            engine: "unloaded",
            message: settings.preloadModel
              ? "Preparing the speech model"
              : "Speech runtime installed — speech model loads on demand",
            migrationRequired: false,
          }
        : {
            phase: "idle",
            engine: "missing",
            message: migrationRequired
              ? "Speech runtime update required"
              : "Speech runtime setup required",
            migrationRequired,
          },
    );
    this.updateMagicStatus(
      magicReady
        ? {
            phase: "idle",
            engine: "unloaded",
            message: settings.magicEnabled
              ? "Rewrite runtime installed — rewrite model loads on demand"
              : "Rewrite runtime installed — rewriting available on demand",
          }
        : { phase: "idle", engine: "missing", message: "Rewrite runtime setup required" },
    );
    if (ready && settings.preloadModel) {
      void this.loadModel(settings).catch((error) => this.fail(error));
    }
    if (
      magicReady && settings.preloadMagicModel &&
      settings.memoryPolicy !== "balanced"
    ) {
      void this.loadMagic(settings).catch((error) => this.failMagic(error));
    }
  }

  async isEnvironmentReady(): Promise<boolean> {
    return this.speechInstaller.ready("speech");
  }
  async isMagicEnvironmentReady(): Promise<boolean> {
    return this.magicInstaller.ready("magic");
  }

  async setup(settings: AppSettings): Promise<void> {
    if (this.setupPromise) return this.setupPromise;
    this.shuttingDown = false;
    this.setupPromise = this.maintenance
      .run(() => this.performSetup(settings))
      .then(() => {
        this.speechInstaller.recordSetupOutcome("Model preparation completed");
        this.speechInstaller.setupLog.finish(
          this.speechInstaller.setupLog.activeId, "success",
          "Runtime packages and model load/warmup completed",
        );
      })
      .catch(async (error) => {
        this.speechInstaller.recordSetupOutcome("Setup failed before completion");
        this.speechInstaller.setupLog.finish(
          this.speechInstaller.setupLog.activeId,
          this.speechInstaller.isCancelled ? "cancelled" : "error",
          setupCause(error),
        );
        this.fail(error);
        if (
          !(error instanceof SetupRollbackError) &&
          (await this.isEnvironmentReady())
        )
          this.updateStatus({
            phase: "idle",
            engine: "unloaded",
            message:
              "Setup failed; your existing speech runtime is preserved. Load the speech model to continue, or retry Repair.",
            progress: null,
          });
        throw error;
      })
      .finally(() => {
        this.setupPromise = null;
        this.applyDeferredResidency();
      });
    return this.setupPromise;
  }

  private async performSetup(settings: AppSettings): Promise<void> {
    this.speechInstaller.setupLog.begin("speech");
    this.speechInstaller.recordSetupStage("Preparing speech setup");
    const reloadMagic =
      settings.memoryPolicy !== "balanced" &&
      settings.preloadMagicModel && (await this.isMagicEnvironmentReady());
    await this.speechWorker.stopAndWait();
    this.clearSpeechIdle();
    this.updateStatus({ ...UNLOADED_LIFECYCLE });
    await this.speechInstaller.install("speech", settings, (progress) =>
      this.updateStatus({
        phase: "preparing",
        engine: "settingUp",
        ...progress,
      }),
    );
    this.updateStatus({
      phase: "loading",
      engine: "loading",
      message: "Downloading and loading the speech model",
      progress: 0.82,
    });
    this.speechInstaller.recordSetupStage("Downloading, loading and warming up the speech model");
    try {
      await this.loadModel(settings, true);
      if (reloadMagic && this.magicStatus.engine !== "ready") {
        this.speechInstaller.recordSetupStage("Restoring preloaded rewrite model");
        await this.loadMagic(settings, true);
      }
    } catch (error) {
      await this.speechWorker.stopAndWait();
      try {
        this.speechInstaller.rollback();
      } catch (rollbackError) {
        throw new SetupRollbackError(error, rollbackError);
      }
      throw error;
    }
  }

  async setupMagic(settings: AppSettings): Promise<void> {
    if (this.magicSetupPromise) return this.magicSetupPromise;
    this.shuttingDown = false;
    this.magicSetupPromise = this.maintenance
      .run(() => this.performMagicSetup(settings))
      .then(() => {
        this.magicInstaller.recordSetupOutcome("Rewrite model preparation completed");
        this.magicInstaller.setupLog.finish(
          this.magicInstaller.setupLog.activeId, "success",
          "Runtime packages and rewrite model load/warmup completed",
        );
      })
      .catch(async (error) => {
        this.magicInstaller.recordSetupOutcome("Setup failed before completion");
        this.magicInstaller.setupLog.finish(
          this.magicInstaller.setupLog.activeId,
          this.magicInstaller.isCancelled ? "cancelled" : "error",
          setupCause(error),
        );
        this.failMagic(error);
        if (
          !(error instanceof SetupRollbackError) &&
          (await this.isMagicEnvironmentReady())
        )
          this.updateMagicStatus({
            phase: "idle",
            engine: "unloaded",
            message:
              "Setup failed; your existing rewrite runtime is preserved. Load the rewrite model to continue, or retry Repair.",
            progress: null,
          });
        throw error;
      })
      .finally(() => {
        this.magicSetupPromise = null;
        this.applyDeferredResidency();
      });
    return this.magicSetupPromise;
  }

  private async performMagicSetup(settings: AppSettings): Promise<void> {
    this.magicInstaller.setupLog.begin("rewrite");
    this.magicInstaller.recordSetupStage("Preparing rewrite setup");
    const reloadSpeech =
      settings.preloadModel && (await this.isEnvironmentReady());
    await this.magicWorker.stopAndWait();
    this.clearMagicIdle();
    this.updateMagicStatus({ ...UNLOADED_LIFECYCLE });
    await this.magicInstaller.install("magic", settings, (progress) =>
      this.updateMagicStatus({
        phase: "preparing",
        engine: "settingUp",
        ...progress,
      }),
    );
    const model = magicModelById(settings.magicModel);
    this.updateMagicStatus({
      phase: "loading",
      engine: "loading",
      message: `Downloading and loading rewrite model ${model.name}`,
      progress: 0.82,
    });
    this.magicInstaller.recordSetupStage("Downloading, loading and warming up the rewrite model");
    try {
      await this.loadMagic(settings, true);
      if (reloadSpeech && this.status.engine !== "ready") {
        this.magicInstaller.recordSetupStage("Restoring preloaded speech model");
        await this.loadModel(settings, true);
      }
    } catch (error) {
      await this.magicWorker.stopAndWait();
      try {
        this.magicInstaller.rollback();
      } catch (rollbackError) {
        throw new SetupRollbackError(error, rollbackError);
      }
      throw error;
    }
  }

  private workerEnvironment(kind: "speech" | "magic"): NodeJS.ProcessEnv {
    let bin = join(
      kind === "speech"
        ? this.storage.venvDirectory
        : this.storage.magicVenvDirectory,
      process.platform === "win32" ? "Scripts" : "bin",
    );
    try {
      bin = dirname(
        kind === "speech"
          ? this.speechInstaller.python
          : this.magicInstaller.python,
      );
    } catch {
      /* Repair must still run when the old activation record is damaged. */
    }
    return runtimeEnvironment(
      kind,
      this.storage.dataDirectory,
      this.storage.modelCacheDirectory,
      bin,
    );
  }

  private request<T>(
    kind: "speech" | "magic",
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (this.shuttingDown)
      return Promise.reject(new Error("The model engines are shutting down"));
    const commands = kind === "speech"
      ? ["capabilities", "ping", "load", "unload", "status", "transcribe", "shutdown"]
      : ["capabilities", "ping", "magicLoad", "magicUnload", "magicStatus", "magicRewrite", "shutdown"];
    if (!commands.includes(command))
      return Promise.reject(new Error(`${command} is not allowed in the ${kind} runtime`));
    const worker = kind === "speech" ? this.speechWorker : this.magicWorker;
    return worker.request<T>(command, payload, timeoutMs);
  }

  private async negotiateCapabilities(kind: "speech" | "magic"): Promise<BackendCapabilities> {
    const engine = kind === "speech" ? "speech" : "writing";
    const capabilities = await this.request<BackendCapabilities>(kind, "capabilities", { engine });
    const backend = kind === "magic"
      ? "transformers"
      : speechModelForPlatform() === "r2t2Mlx"
        ? "mlx"
        : process.platform === "win32" ? "cuda-transformers" : "cuda-vllm";
    const modelFamily = kind === "speech" ? "r2t2" : "qwen3.5";
    if (capabilities.engine !== engine || capabilities.modelFamily !== modelFamily || capabilities.backend !== backend) {
      throw new Error(
        `The ${engine} runtime reported an incompatible adapter. Expected ${backend} for ${modelFamily}; repair the local runtime before loading a model.`,
      );
    }
    return capabilities;
  }

  private runModelOperation<T>(
    settings: AppSettings,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (settings.memoryPolicy !== "balanced") return operation();
    return this.modelOperations
      .run(operation)
      .finally(() => this.applyDeferredResidency());
  }

  private async releaseMagicForSpeech(settings: AppSettings): Promise<void> {
    if (settings.memoryPolicy !== "balanced") return;
    await this.magicUnloadPromise;
    if (
      this.magicStatus.engine === "missing" ||
      this.magicStatus.engine === "unloaded"
    ) return;
    // Called inside the balanced operation queue: rewriting has finished and
    // its result is already returned. Stopping only the worker leaves raw
    // transcripts, buffered audio and settings in their owning services.
    await this.performUnloadMagic(true);
    this.updateMagicStatus({
      message: "Magic released for speech by balanced memory policy",
    });
  }

  async loadModel(settings: AppSettings, fromSetup = false, eligible: () => boolean = () => true): Promise<void> {
    return this.runModelOperation(settings, () =>
      this.performLoadModel(settings, fromSetup, eligible),
    );
  }

  private async performLoadModel(
    settings: AppSettings,
    fromSetup = false,
    eligible: () => boolean = () => true,
  ): Promise<void> {
    if (!eligible()) return;
    if (this.shuttingDown)
      throw new Error("The speech model worker is shutting down");
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
    if (this.loadPromise) return this.loadPromise;
    this.clearSpeechIdle();
    this.loadPromise = (async () => {
      await this.speechUnloadPromise;
      await this.releaseMagicForSpeech(settings);
      if (!eligible()) return;
      const ready = fromSetup || (await this.isEnvironmentReady());
      if (!eligible()) return;
      if (!ready)
        throw new Error(
          "Speech runtime setup is required before loading the speech model",
        );
      const model = modelById(settings.model);
      this.updateStatus({
        phase: "loading",
        engine: "loading",
        residency: "loading",
        warmup: "unknown",
        device: null,
        detail: null,
        capabilities: null,
        message: `Loading and warming up speech model ${model.name}. Ready means speech inference has been exercised, not just the weights loaded.`,
        model: settings.model,
        progress: 0.85,
      });
      const capabilities = await this.negotiateCapabilities("speech");
      this.updateStatus({ capabilities });
      if (!eligible()) return;
      const runtime = await this.request<WorkerRuntime>("speech", "load", {
        cacheDir: this.storage.modelCacheDirectory,
      });
      if (!runtime.loaded) throw new Error("Speech model load did not report loaded weights");
      if (!eligible()) return;
      this.updateStatus({
        ...reportedLifecycle(runtime),
        phase: "idle",
        engine: "ready",
        message: runtime.warmup === "complete" ? `${model.name} ready` : `${model.name} loaded; warmup not reported complete`,
        detail: null,
        model: settings.model,
        progress: 1,
        migrationRequired: false,
      });
      this.scheduleSpeechIdle();
    })()
      .catch(async (error) => {
        if (!eligible()) return;
        await this.speechWorker.stopAndWait();
        if (!eligible()) return;
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.loadPromise = null;
        this.applyDeferredResidency();
      });
    return this.loadPromise;
  }

  async ensureLoaded(
    settings: AppSettings,
    eligible: () => boolean = () => true,
  ): Promise<void> {
    if (!eligible()) return;
    if (this.shuttingDown)
      throw new Error("The speech model worker is shutting down");
    await this.speechUnloadPromise;
    if (!eligible()) return;
    if (this.shuttingDown)
      throw new Error("The speech model worker is shutting down");
    if (this.status.engine === "ready" && this.status.model === settings.model)
      return;
    await this.performLoadModel(settings, false, eligible);
  }

  async transcribe(
    payload: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<Record<string, unknown>> {
    return this.runModelOperation(settings, () =>
      this.performTranscription(payload, settings),
    );
  }

  private async performTranscription(
    payload: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<Record<string, unknown>> {
    const started = performance.now();
    this.speechOperations += 1;
    this.clearSpeechIdle();
    try {
      await this.releaseMagicForSpeech(settings);
      await this.ensureLoaded(settings);
      this.clearSpeechIdle();
      const capabilities = this.status.capabilities;
      if (!capabilities) {
        throw new Error("Speech capabilities are unavailable. Reload the speech model before recording again.");
      }
      if (!capabilities.languageHints.supported || !capabilities.languageHints.languages.includes(settings.language)) {
        const choices = capabilities.languageHints.languages.join(", ");
        throw new Error(
          `The speech adapter does not support language ${settings.language}. ${choices
            ? `Choose a supported language in Settings: ${choices}.`
            : "This adapter advertises no language hints; repair the local speech runtime."}`,
        );
      }
      const result = await this.request<Record<string, unknown>>(
        "speech",
        "transcribe",
        {
          ...payload,
          language: settings.language,
        },
        transcriptionTimeout(payload.durationMs),
      );
      return {
        ...result,
        processingTime: (performance.now() - started) / 1000,
      };
    } finally {
      this.speechOperations -= 1;
      this.scheduleSpeechIdle();
      this.applyDeferredResidency();
    }
  }

  async unload(): Promise<void> {
    if (this.modelOperations.busy)
      throw new Error("Wait for the current model operation before unloading");
    if (this.speechUnloadPromise) return this.speechUnloadPromise;
    if (
      this.speechWorker.busy ||
      this.loadPromise ||
      this.speechOperations > 0 ||
      !this.canIdleUnload()
    )
      throw new Error("Wait for speech to finish before unloading");
    this.clearSpeechIdle();
    this.speechUnloadPromise = (async () => {
      this.updateStatus({ residency: "unloading", idleUnloadAt: null });
      await this.speechWorker.stopAndWait();
      this.updateStatus({
        phase: "idle",
        engine: existsSync(this.venvPython()) ? "unloaded" : "missing",
        message: "Speech model unloaded",
        model: null,
        progress: null,
      });
    })()
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.speechUnloadPromise = null;
        this.applyDeferredResidency();
      });
    return this.speechUnloadPromise;
  }

  async loadMagic(settings: AppSettings, fromSetup = false, eligible: () => boolean = () => true): Promise<void> {
    return this.runModelOperation(settings, () =>
      this.performLoadMagic(settings, fromSetup, eligible),
    );
  }

  private async performLoadMagic(
    settings: AppSettings,
    fromSetup = false,
    eligible: () => boolean = () => true,
  ): Promise<void> {
    if (!eligible()) return;
    if (this.shuttingDown)
      throw new Error("The rewrite model worker is shutting down");
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
    if (this.magicLoadPromise) return this.magicLoadPromise;
    this.clearMagicIdle();
    this.magicLoadPromise = (async () => {
      await this.magicUnloadPromise;
      if (!eligible()) return;
      const ready = fromSetup || (await this.isMagicEnvironmentReady());
      if (!eligible()) return;
      if (!ready)
        throw new Error("Install the rewrite runtime before loading a model");
      const model = magicModelById(settings.magicModel);
      this.updateMagicStatus({
        phase: "loading",
        engine: "loading",
        residency: "loading",
        warmup: "unknown",
        device: null,
        detail: null,
        capabilities: null,
        message: `Loading rewrite model ${model.name}`,
        model: settings.magicModel,
        progress: 0.86,
      });
      const capabilities = await this.negotiateCapabilities("magic");
      this.updateMagicStatus({ capabilities });
      if (!eligible()) return;
      const runtime = await this.request<WorkerRuntime>(
        "magic",
        "magicLoad",
        {
          model: settings.magicModel,
          cacheDir: this.storage.modelCacheDirectory,
        },
      );
      if (!runtime.loaded) throw new Error("Writing model load did not report loaded weights");
      if (!eligible()) return;
      this.updateMagicStatus({
        ...reportedLifecycle(runtime),
        phase: "idle",
        engine: "ready",
        message: runtime.warmup === "complete" ? `${model.name} ready` : `${model.name} loaded; warmup not reported complete`,
        model: settings.magicModel,
        progress: 1,
      });
      this.scheduleMagicIdle();
    })()
      .catch((error) => {
        if (!eligible()) return;
        this.failMagic(error);
        throw error;
      })
      .finally(() => {
        this.magicLoadPromise = null;
        this.applyDeferredResidency();
      });
    return this.magicLoadPromise;
  }

  async ensureMagicLoaded(
    settings: AppSettings,
    eligible: () => boolean = () => true,
  ): Promise<void> {
    if (!eligible()) return;
    if (this.shuttingDown)
      throw new Error("The rewrite model worker is shutting down");
    await this.magicUnloadPromise;
    if (!eligible()) return;
    if (this.shuttingDown)
      throw new Error("The rewrite model worker is shutting down");
    if (
      this.magicStatus.engine === "ready" &&
      this.magicStatus.model === settings.magicModel
    )
      return;
    await this.performLoadMagic(settings, false, eligible);
  }

  async rewriteMagic(
    request: MagicRewriteRequest,
    settings: AppSettings,
  ): Promise<MagicRewriteResult> {
    const parts = splitForRewrite(
      request.text, settings.customWords, request.sourceLanguage ?? settings.language,
    );
    if (parts.filter((part) => !part.protected && part.text.trim()).length > 16)
      throw new Error(
        "This text contains too many separate protected blocks or identifiers to rewrite at once. Rewrite a shorter selection.",
      );
    this.magicOperations += 1;
    this.clearMagicIdle();
    try {
      await this.ensureMagicLoaded(settings);
      this.clearMagicIdle();
      const model = magicModelById(settings.magicModel);
      this.updateMagicStatus({
        phase: "rewriting",
        engine: "ready",
        message: `${model.name} is rewriting`,
        progress: null,
      });
      const output: string[] = [];
      let processingTimeMs = 0;
      for (const part of parts) {
        if (part.protected || !part.text.trim()) {
          output.push(part.text);
          continue;
        }
        const result = await this.request<MagicRewriteResult & Partial<WorkerRuntime>>(
          "magic",
          "magicRewrite",
          {
            ...request,
            text: part.text.trim(),
          } as unknown as Record<string, unknown>,
        );
        if (result.residency !== undefined || result.warmup !== undefined || result.device !== undefined) {
          this.updateMagicStatus({
            ...(result.residency !== undefined ? { residency: result.residency } : {}),
            ...(result.warmup !== undefined ? { warmup: result.warmup } : {}),
            ...(result.device !== undefined ? { device: result.device } : {}),
          });
        }
        processingTimeMs += result.processingTimeMs;
        // Preserve separators around immutable blocks; they never enter the model.
        output.push(
          (part.text.match(/^\s*/)?.[0] ?? "") +
            result.text.trim() +
            (part.text.match(/\s*$/)?.[0] ?? ""),
        );
      }
      const text = output.join("");
      this.updateMagicStatus({
        phase: "idle",
        engine: "ready",
        message: runtime.warmup === "complete" ? `${model.name} ready` : `${model.name} loaded; warmup not reported complete`,
        progress: 1,
      });
      return {
        model: settings.magicModel,
        processingTimeMs,
        inputCharacters: request.text.length,
        includedInferences: request.allowInferences,
        preset: request.preset,
        text,
        outputCharacters: text.length,
      };
    } catch (error) {
      this.failMagic(error);
      throw error;
    } finally {
      this.magicOperations -= 1;
      this.scheduleMagicIdle();
      this.applyDeferredResidency();
    }
  }

  async unloadMagic(): Promise<void> {
    if (this.modelOperations.busy)
      throw new Error("Wait for the current model operation before unloading");
    return this.performUnloadMagic();
  }

  private async performUnloadMagic(forSpeech = false): Promise<void> {
    if (this.magicUnloadPromise) return this.magicUnloadPromise;
    if (
      this.magicWorker.busy ||
      this.magicLoadPromise ||
      this.magicOperations > 0 ||
      (!forSpeech && !this.canIdleUnload())
    )
      throw new Error("Wait for rewriting to finish before unloading the rewrite model");
    this.clearMagicIdle();
    this.magicUnloadPromise = (async () => {
      this.updateMagicStatus({ residency: "unloading", idleUnloadAt: null });
      await this.magicWorker.stopAndWait();
      this.updateMagicStatus({
        phase: "idle",
        engine: existsSync(this.magicInstaller.python) ? "unloaded" : "missing",
        message: "Rewrite model unloaded",
        model: null,
        device: null,
        progress: null,
      });
    })()
      .catch((error) => {
        this.failMagic(error);
        throw error;
      })
      .finally(() => {
        this.magicUnloadPromise = null;
        this.applyDeferredResidency();
      });
    return this.magicUnloadPromise;
  }

  configureResidency(settings: AppSettings): void {
    if (this.shuttingDown) return;
    // Apply saved timer policy even when a request is still pending. Completion
    // reads storage again rather than restoring the request's old snapshot.
    this.scheduleSpeechIdle();
    this.scheduleMagicIdle();
    if (this.isBusy) {
      this.residencyPending = true;
      return;
    }
    this.residencyPending = false;
    if (settings.preloadModel && this.status.engine !== "error") {
      this.clearSpeechIdle();
      const generation = this.speechFailureGeneration;
      const eligible = () =>
        !this.shuttingDown &&
        generation === this.speechFailureGeneration &&
        this.status.engine !== "error";
      void this.isEnvironmentReady()
        .then((ready) => {
          const current = this.storage.getSettings();
          if (!ready || !current.preloadModel || !eligible()) return;
          if (this.isBusy) this.residencyPending = true;
          else
            void this.runModelOperation(current, () => this.ensureLoaded(current, eligible)).catch((error) => {
              if (eligible()) this.fail(error);
            });
        })
        .catch((error) => {
          if (eligible()) this.fail(error);
        });
    }
    if (settings.preloadMagicModel && settings.memoryPolicy !== "balanced" && this.magicStatus.engine !== "error") {
      this.clearMagicIdle();
      const generation = this.magicFailureGeneration;
      const eligible = () =>
        !this.shuttingDown &&
        generation === this.magicFailureGeneration &&
        this.magicStatus.engine !== "error";
      void this.isMagicEnvironmentReady()
        .then((ready) => {
          const current = this.storage.getSettings();
          if (!ready || !current.preloadMagicModel || current.memoryPolicy === "balanced" || !eligible()) return;
          if (this.isBusy) this.residencyPending = true;
          else
            void this.runModelOperation(current, () => this.ensureMagicLoaded(current, eligible)).catch((error) => {
              if (eligible()) this.failMagic(error);
            });
        })
        .catch((error) => {
          if (eligible()) this.failMagic(error);
        });
    }
  }

  private applyDeferredResidency(): void {
    if (this.residencyPending && !this.isBusy)
      this.configureResidency(this.storage.getSettings());
  }

  private clearSpeechIdle(): void {
    if (this.speechIdleTimer) clearTimeout(this.speechIdleTimer);
    this.speechIdleTimer = null;
    if (this.status.idleUnloadAt !== null) this.updateStatus({ idleUnloadAt: null });
  }

  private clearMagicIdle(): void {
    if (this.magicIdleTimer) clearTimeout(this.magicIdleTimer);
    this.magicIdleTimer = null;
    if (this.magicStatus.idleUnloadAt !== null) this.updateMagicStatus({ idleUnloadAt: null });
  }

  private scheduleSpeechIdle(): void {
    this.clearSpeechIdle();
    const settings = this.storage.getSettings();
    if (
      this.shuttingDown ||
      settings.preloadModel ||
      this.status.engine !== "ready"
    )
      return;
    this.speechIdleTimer = setTimeout(() => {
      this.speechIdleTimer = null;
      this.updateStatus({ idleUnloadAt: null });
      if (
        this.shuttingDown ||
        this.storage.getSettings().preloadModel ||
        this.status.engine !== "ready"
      )
        return;
      if (this.isBusy || !this.canIdleUnload()) this.scheduleSpeechIdle();
      else void this.unload().catch((error) => this.fail(error));
    }, settings.modelIdleMinutes * 60_000);
    this.updateStatus({ idleUnloadAt: Date.now() + settings.modelIdleMinutes * 60_000 });
  }

  private scheduleMagicIdle(): void {
    this.clearMagicIdle();
    const settings = this.storage.getSettings();
    if (
      this.shuttingDown ||
      (settings.preloadMagicModel && settings.memoryPolicy !== "balanced") ||
      this.magicStatus.engine !== "ready"
    )
      return;
    this.magicIdleTimer = setTimeout(() => {
      this.magicIdleTimer = null;
      this.updateMagicStatus({ idleUnloadAt: null });
      if (
        this.shuttingDown ||
        (this.storage.getSettings().preloadMagicModel && this.storage.getSettings().memoryPolicy !== "balanced") ||
        this.magicStatus.engine !== "ready"
      )
        return;
      if (this.isBusy || !this.canIdleUnload()) this.scheduleMagicIdle();
      else void this.unloadMagic().catch((error) => this.failMagic(error));
    }, settings.modelIdleMinutes * 60_000);
    this.updateMagicStatus({ idleUnloadAt: Date.now() + settings.modelIdleMinutes * 60_000 });
  }

  async reset(): Promise<void> {
    await this.shutdown();
    if (existsSync(this.storage.venvDirectory))
      rmSync(this.storage.venvDirectory, { recursive: true, force: true });
    if (existsSync(this.storage.magicVenvDirectory))
      rmSync(this.storage.magicVenvDirectory, { recursive: true, force: true });
    this.updateStatus({
      phase: "idle",
      engine: "missing",
      message: "Speech and rewrite runtimes removed",
      model: null,
      progress: null,
      migrationRequired: false,
    });
    this.updateMagicStatus({
      phase: "idle",
      engine: "missing",
      message: "Rewrite runtime setup required",
      model: null,
      device: null,
      progress: null,
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.residencyPending = false;
    this.speechInstaller.stop();
    this.magicInstaller.stop();
    this.clearSpeechIdle();
    this.clearMagicIdle();
    await Promise.all([
      this.speechWorker.stopAndWait(),
      this.magicWorker.stopAndWait(),
    ]);
    this.updateStatus({ ...UNLOADED_LIFECYCLE });
    this.updateMagicStatus({ ...UNLOADED_LIFECYCLE });
  }

  fail(error: unknown): void {
    this.clearSpeechIdle();
    this.speechFailureGeneration += 1;
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeFileSync(
        join(this.storage.dataDirectory, "last-asr-error.log"),
        privateFailureLog("speech", error, this.speechWorker.stderr),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      /* diagnostics are best-effort */
    }
    this.updateStatus({
      ...failedLifecycle(this.speechWorker.running),
      phase: "error",
      engine: "error",
      message: conciseError(message),
      detail: message,
      progress: null,
    });
  }

  failMagic(error: unknown): void {
    this.clearMagicIdle();
    this.magicFailureGeneration += 1;
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeFileSync(
        join(this.storage.dataDirectory, "last-magic-error.log"),
        privateFailureLog("magic", error, this.magicWorker.stderr),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      /* diagnostics are best-effort */
    }
    this.updateMagicStatus({
      ...failedLifecycle(this.magicWorker.running),
      phase: "error",
      engine: "error",
      message: conciseError(message),
      detail: message,
      progress: null,
    });
  }
}
