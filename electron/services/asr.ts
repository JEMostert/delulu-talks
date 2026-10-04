import {
  normalizeRewriteContext,
  splitTechnicalBlocks,
} from "../../src/rewriteContext";
import { normalizeSpeechExecution } from "../../src/speechModels";
import { splitForRewrite } from "../../src/personalization";
import { normalizeTimings } from "../../src/pipelineTimings";
import {
  DomainError,
  domainError,
  serializeDomainError,
} from "../../src/domainErrors";
import { randomUUID } from "node:crypto";
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
  SetupStage,
} from "../../src/types";
import type { StorageService } from "./storage";

import { WorkerClient, transcriptionTimeout } from "../runtime/workerClient";
import { SerialQueue } from "../runtime/serialQueue";
import { RuntimeInstaller } from "../runtime/installer";
import { runtimeEnvironment } from "../runtime/environment";
import { speechModelForPlatform, usesMetal } from "../runtime/platform";
import { privateFailureLog } from "../runtime/privateDiagnostics";

function modelSetupStage(stage: string): SetupStage | null {
  return (
    (
      {
        download: "model-download",
        load: "model-load",
        conversion: "model-conversion",
        warmup: "warmup",
      } as Record<string, SetupStage>
    )[stage] ?? null
  );
}

type WorkerRuntime = {
  speechExecution?: unknown;
  loaded: boolean;
  residency?: RuntimeLifecycle["residency"];
  warmup?: RuntimeLifecycle["warmup"];
  device?: string | null;
};

export class RewriteCancelledError extends Error {
  constructor() {
    super("Rewrite cancelled");
    this.name = "RewriteCancelledError";
  }
}

type ManualRewrite = {
  id: string;
  cancelled: boolean;
  settled: boolean;
  cancelPromise: Promise<void> | null;
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
    ? {
        residency: "unknown",
        warmup: "unknown",
        device: null,
        idleUnloadAt: null,
        capabilities: null,
      }
    : UNLOADED_LIFECYCLE;
}

function setupCause(error: unknown, depth = 0): string {
  if (depth > 4) return "Additional nested causes omitted";
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message.slice(0, 2048)}`
      : String(error).slice(0, 2048);
  if (error instanceof AggregateError)
    return `${message}\n${error.errors
      .slice(0, 4)
      .map((cause) => setupCause(cause, depth + 1))
      .join("\n")}`;
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

type SetupOperation = {
  controller: AbortController;
  started: boolean;
  previousEngine: DictationStatus["engine"];
  promise: Promise<void> | null;
  termination?: Promise<void>;
};

/** The speech model the worker runs; Apple Silicon always uses R2T2 on MLX. */
export function speechEngineId(settings: AppSettings): "r2t2" | "nemotron" {
  return !usesMetal() && settings.speechEngine === "nemotron"
    ? "nemotron"
    : "r2t2";
}

export function speechModelName(settings: AppSettings): string {
  return speechEngineId(settings) === "nemotron"
    ? "Nemotron 3.5"
    : modelById(settings.model).name;
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
      !!this.setupPromise ||
      !!this.magicSetupPromise ||
      this.maintenance.busy ||
      this.modelOperations.busy ||
      this.speechWorker.busy ||
      this.magicWorker.busy ||
      !!this.loadPromise ||
      !!this.magicLoadPromise ||
      !!this.speechUnloadPromise ||
      !!this.magicUnloadPromise ||
      this.speechOperations > 0 ||
      this.magicOperations > 0 ||
      !!this.manualRewrite
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
  private speechSetup: SetupOperation | null = null;
  private magicSetup: SetupOperation | null = null;
  private loadPromise: Promise<void> | null = null;
  private magicSetupPromise: Promise<void> | null = null;
  private magicLoadPromise: Promise<void> | null = null;
  private speechUnloadPromise: Promise<void> | null = null;
  private magicUnloadPromise: Promise<void> | null = null;
  private speechOperations = 0;
  private magicOperations = 0;
  private manualRewrite: ManualRewrite | null = null;
  private shuttingDown = false;
  private residencyPending = false;
  private speechFailureGeneration = 0;
  private magicFailureGeneration = 0;
  private speechIdleTimer: NodeJS.Timeout | null = null;
  private loadedEngine: "r2t2" | "nemotron" | null = null;
  private liveActive = false;
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
      (error) => {
        if (!this.speechSetup?.controller.signal.aborted) this.fail(error);
      },
      (detail, event) => {
        if (!this.speechSetup?.controller.signal.aborted)
          this.updateStatus({
            detail,
            ...(event?.command === "load" && modelSetupStage(event.stage)
              ? { setupStage: modelSetupStage(event.stage), progress: null }
              : {}),
            ...(event?.command === "load" && event.stage === "warmup"
              ? { residency: "resident" as const, warmup: "warming" as const }
              : {}),
            downloadBytes:
              event?.command === "load" ? (event.downloadBytes ?? null) : null,
          });
      },
    );
    this.magicWorker = new WorkerClient(
      () => ({
        python: this.magicInstaller.python,
        script: this.scriptPath(),
        env: this.workerEnvironment("magic"),
      }),
      (error) => {
        if (
          !this.magicSetup?.controller.signal.aborted &&
          !this.manualRewrite?.cancelled
        )
          this.failMagic(error);
      },
      (detail, event) => {
        if (
          !this.magicSetup?.controller.signal.aborted &&
          !this.manualRewrite?.cancelled
        )
          this.updateMagicStatus({
            detail,
            ...(event?.command === "magicLoad" && modelSetupStage(event.stage)
              ? { setupStage: modelSetupStage(event.stage), progress: null }
              : {}),
            ...(event?.command === "magicRewrite" && event.stage === "warmup"
              ? {
                  setupStage: "warmup" as const,
                  warmup: "warming" as const,
                  progress: null,
                }
              : {}),
            downloadBytes:
              event?.command === "magicLoad"
                ? (event.downloadBytes ?? null)
                : null,
          });
      },
    );
  }

  onStatus(listener: (status: DictationStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getSetupLog(kind: RuntimeSetupKind): RuntimeSetupLog {
    return (
      kind === "speech" ? this.speechInstaller : this.magicInstaller
    ).setupLog.snapshot(kind);
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

  setSilenceCountdown(remainingSeconds: number | null): void {
    this.updateStatus({ silenceCountdownSeconds: remainingSeconds });
  }

  setActivity(
    phase: DictationStatus["phase"],
    message: string,
    detail?: string,
  ): void {
    this.updateStatus({ phase, message, detail: detail ?? null });
  }

  private updateStatus(patch: Partial<DictationStatus>): void {
    if (
      (patch.phase && patch.phase !== "error") ||
      (patch.engine && patch.engine !== "error")
    )
      patch = { ...patch, failure: null };
    this.status = {
      ...this.status,
      ...(["unloaded", "missing", "error"].includes(patch.engine ?? "")
        ? { setupStage: null }
        : {}),
      ...(patch.engine === "unloaded" || patch.engine === "missing"
        ? UNLOADED_LIFECYCLE
        : {}),
      ...patch,
    };
    if (this.status.engine !== "ready") this.status.speechExecution = null;
    if (
      patch.phase !== undefined ||
      !["preparing", "loading"].includes(this.status.phase)
    )
      this.status.downloadBytes = null;
    for (const listener of this.statusListeners) listener(this.getStatus());
  }

  private updateMagicStatus(patch: Partial<MagicStatus>): void {
    if (
      (patch.phase && patch.phase !== "error") ||
      (patch.engine && patch.engine !== "error")
    )
      patch = { ...patch, failure: null };
    this.magicStatus = {
      ...this.magicStatus,
      ...(["unloaded", "missing", "error"].includes(patch.engine ?? "")
        ? { setupStage: null }
        : {}),
      ...(patch.engine === "unloaded" || patch.engine === "missing"
        ? UNLOADED_LIFECYCLE
        : {}),
      ...patch,
    };
    if (
      patch.phase !== undefined ||
      !["preparing", "loading"].includes(this.magicStatus.phase)
    )
      this.magicStatus.downloadBytes = null;
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
        : {
            phase: "idle",
            engine: "missing",
            message: "Rewrite runtime setup required",
          },
    );
    if (ready && settings.preloadModel) {
      void this.loadModel(settings).catch((error) => this.fail(error));
    }
    if (
      magicReady &&
      settings.preloadMagicModel &&
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
    const operation: SetupOperation = {
      controller: new AbortController(),
      started: false,
      previousEngine: this.status.engine,
      promise: null,
    };
    this.speechSetup = operation;
    this.setupPromise = this.setupRuntime(
      "speech",
      settings,
      operation,
    ).finally(() => {
      this.setupPromise = null;
      if (this.speechSetup === operation) this.speechSetup = null;
      if (!operation.controller.signal.aborted) this.applyDeferredResidency();
    });
    operation.promise = this.setupPromise;
    return this.setupPromise;
  }

  async setupMagic(settings: AppSettings): Promise<void> {
    if (this.magicSetupPromise) return this.magicSetupPromise;
    const operation: SetupOperation = {
      controller: new AbortController(),
      started: false,
      previousEngine: this.magicStatus.engine,
      promise: null,
    };
    this.magicSetup = operation;
    this.magicSetupPromise = this.setupRuntime(
      "magic",
      settings,
      operation,
    ).finally(() => {
      this.magicSetupPromise = null;
      if (this.magicSetup === operation) this.magicSetup = null;
      if (!operation.controller.signal.aborted) this.applyDeferredResidency();
    });
    operation.promise = this.magicSetupPromise;
    return this.magicSetupPromise;
  }

  async cancelSetup(kind: "speech" | "magic" = "speech"): Promise<void> {
    const operation = kind === "speech" ? this.speechSetup : this.magicSetup;
    if (!operation) return;
    operation.controller.abort(new Error("Runtime setup cancelled"));
    if (kind === "speech") {
      this.clearSpeechIdle();
      this.updateStatus({
        setupState: "cancelling",
        message: "Cancelling setup — releasing runtime resources…",
        progress: null,
      });
    } else {
      this.clearMagicIdle();
      this.updateMagicStatus({
        setupState: "cancelling",
        message: "Cancelling rewriting setup — releasing runtime resources…",
        progress: null,
      });
    }
    if (operation.started) await this.terminateSetup(kind, operation);
    // The original operation owns candidate disposal and the terminal status.
    await operation.promise;
  }

  private terminateSetup(
    kind: "speech" | "magic",
    operation: SetupOperation,
  ): Promise<void> {
    if (!operation.termination) {
      const installer =
        kind === "speech" ? this.speechInstaller : this.magicInstaller;
      const worker = kind === "speech" ? this.speechWorker : this.magicWorker;
      operation.termination = Promise.all([
        installer.stopAndWait(),
        worker.stopAndWait(),
      ]).then(() => undefined);
    }
    return operation.termination;
  }

  private async setupRuntime(
    kind: "speech" | "magic",
    settings: AppSettings,
    operation: SetupOperation,
  ): Promise<void> {
    this.shuttingDown = false;
    const installer =
      kind === "speech" ? this.speechInstaller : this.magicInstaller;
    const worker = kind === "speech" ? this.speechWorker : this.magicWorker;
    const signal = operation.controller.signal;
    installer.setupLog.begin(kind === "speech" ? "speech" : "rewrite");
    installer.recordSetupStage("Preparing owned runtime candidate");
    const current = () =>
      !signal.aborted &&
      !this.shuttingDown &&
      !operation.termination &&
      (kind === "speech" ? this.speechSetup : this.magicSetup) === operation;
    if (kind === "speech")
      this.updateStatus({
        setupState: "running",
        phase: "preparing",
        engine: "settingUp",
        message: "Preparing speech setup",
        progress: null,
      });
    else
      this.updateMagicStatus({
        setupState: "running",
        phase: "preparing",
        engine: "settingUp",
        message: "Preparing rewriting setup",
        progress: null,
      });
    try {
      await this.maintenance.run(async () => {
        try {
          signal.throwIfAborted();
          operation.started = true;
          await worker.stopAndWait();
          if (kind === "speech") this.updateStatus({ ...UNLOADED_LIFECYCLE });
          else this.updateMagicStatus({ ...UNLOADED_LIFECYCLE });
          signal.throwIfAborted();
          await installer.install(
            kind,
            settings,
            (progress) => {
              if (!current()) return;
              if (kind === "speech")
                this.updateStatus({
                  phase: "preparing",
                  engine: "settingUp",
                  ...progress,
                });
              else
                this.updateMagicStatus({
                  phase: "preparing",
                  engine: "settingUp",
                  ...progress,
                });
            },
            { signal, deferActivation: true },
          );
          signal.throwIfAborted();
          // Only this setup worker sees the prepared candidate. The saved active
          // pointer remains unchanged throughout model download/load/warmup.
          if (kind === "speech") await this.loadModel(settings, true, current);
          else await this.loadMagic(settings, true, current);
          signal.throwIfAborted();
          if (this.shuttingDown)
            throw new Error("Runtime setup interrupted by shutdown");
          if (kind === "magic") {
            // Exercise writing inference before publishing the candidate pointer.
            // This fixed local warmup is never stored or delivered.
            await this.request("magic", "magicRewrite", {
              text: "Warmup.",
              preset: "polish",
              instructions: "",
              allowInferences: false,
              warmup: true,
            });
          }
          signal.throwIfAborted();
          const runtime = await this.request<WorkerRuntime>(
            kind,
            kind === "speech" ? "status" : "magicStatus",
          );
          if (!runtime.loaded || runtime.warmup !== "complete")
            throw new Error(
              "Candidate inference warmup did not complete; previous runtime remains selected",
            );
          signal.throwIfAborted();
          if (!current())
            throw new Error("Runtime candidate no longer owns setup");
          installer.commit();
          installer.setupLog.finish(
            installer.setupLog.activeId,
            "success",
            "Runtime activated after inference warmup",
          );
          const completed = {
            ...reportedLifecycle(runtime),
            phase: "idle" as const,
            engine: "ready" as const,
            setupStage: "ready" as const,
            setupState: "complete" as const,
            message: "Runtime activated after inference warmup",
            detail: null,
            progress: 1,
          };
          if (kind === "speech")
            this.updateStatus({
              ...completed,
              speechExecution:
                normalizeSpeechExecution(runtime.speechExecution) ?? null,
              migrationRequired: false,
            });
          else this.updateMagicStatus(completed);
          // Apply configured preloads after this transaction releases its
          // reservation, without making the other runtime part of cancellation.
          this.residencyPending = true;
        } catch (error) {
          // Keep the maintenance reservation until children are released and
          // the staged candidate is no longer visible to worker configuration.
          if (operation.started) {
            await this.terminateSetup(kind, operation);
            installer.discard();
            installer.resetCancellation();
          }
          throw error;
        }
      });
    } catch (error) {
      installer.setupLog.finish(
        installer.setupLog.activeId,
        signal.aborted ? "cancelled" : "error",
        signal.aborted
          ? "Setup cancelled; previous runtime preserved"
          : "Setup failed; previous runtime preserved",
      );
      if (signal.aborted) {
        let installed = false;
        try {
          installed = existsSync(installer.python);
        } catch {
          /* damaged activation */
        }
        const engine = operation.started
          ? installed
            ? "unloaded"
            : "missing"
          : operation.previousEngine;
        const patch = {
          phase: "idle" as const,
          engine,
          setupState: "cancelled" as const,
          message:
            installed || (!operation.started && engine !== "missing")
              ? "Setup cancelled. Your previous runtime is preserved."
              : "Setup cancelled. No new runtime was activated; setup is still required.",
          detail: null,
          progress: null,
        };
        if (kind === "speech")
          this.updateStatus({
            ...patch,
            ...(operation.started ? { model: null } : {}),
          });
        else
          this.updateMagicStatus({
            ...patch,
            ...(operation.started ? { model: null, device: null } : {}),
          });
        return;
      }
      if (kind === "speech") {
        this.fail(error);
        this.updateStatus({ setupState: "failed" });
        if (await this.isEnvironmentReady())
          this.updateStatus({
            phase: "idle",
            engine: "unloaded",
            message:
              "Setup failed; your existing runtime is preserved. Load it to continue, or retry Repair.",
            progress: null,
          });
      } else {
        this.failMagic(error);
        this.updateMagicStatus({ setupState: "failed" });
        if (await this.isMagicEnvironmentReady())
          this.updateMagicStatus({
            phase: "idle",
            engine: "unloaded",
            message:
              "Setup failed; your existing Writing runtime is preserved. Load it to continue, or retry Repair.",
            progress: null,
          });
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
    const commands =
      kind === "speech"
        ? [
            "capabilities",
            "ping",
            "load",
            "unload",
            "status",
            "transcribe",
            "streamStart",
            "streamAudio",
            "streamFinish",
            "shutdown",
          ]
        : [
            "capabilities",
            "ping",
            "magicLoad",
            "magicUnload",
            "magicStatus",
            "magicRewrite",
            "shutdown",
          ];
    if (!commands.includes(command))
      return Promise.reject(
        new Error(`${command} is not allowed in the ${kind} runtime`),
      );
    const worker = kind === "speech" ? this.speechWorker : this.magicWorker;
    return worker.request<T>(command, payload, timeoutMs);
  }

  private async negotiateCapabilities(
    kind: "speech" | "magic",
  ): Promise<BackendCapabilities> {
    const engine = kind === "speech" ? "speech" : "writing";
    const capabilities = await this.request<BackendCapabilities>(
      kind,
      "capabilities",
      { engine },
    );
    const backend =
      kind === "magic"
        ? "transformers"
        : speechModelForPlatform() === "r2t2Mlx"
          ? "mlx"
          : "cuda-transformers";
    const modelFamily = kind === "speech" ? "r2t2" : "qwen3.5";
    if (
      capabilities.engine !== engine ||
      (kind === "speech"
        ? !["r2t2", "nemotron"].includes(capabilities.modelFamily)
        : capabilities.modelFamily !== modelFamily) ||
      capabilities.backend !== backend
    ) {
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
    )
      return;
    // Called inside the balanced operation queue: rewriting has finished and
    // its result is already returned. Stopping only the worker leaves raw
    // transcripts, buffered audio and settings in their owning services.
    await this.performUnloadMagic(true);
    this.updateMagicStatus({
      message: "Magic released for speech by balanced memory policy",
    });
  }

  async loadModel(
    settings: AppSettings,
    fromSetup = false,
    eligible: () => boolean = () => true,
  ): Promise<void> {
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
      const model = { name: speechModelName(settings) };
      this.updateStatus({
        phase: "loading",
        engine: "loading",
        setupStage: "model-prepare",
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
        model: speechEngineId(settings),
        device: settings.speechDevice,
      });
      this.loadedEngine = speechEngineId(settings);
      if (!runtime.loaded)
        throw new Error("Speech model load did not report loaded weights");
      if (!eligible()) return;
      this.updateStatus({
        ...reportedLifecycle(runtime),
        phase: fromSetup ? "preparing" : "idle",
        engine: fromSetup ? "settingUp" : "ready",
        setupStage: fromSetup
          ? "warmup"
          : runtime.warmup === "complete"
            ? "ready"
            : "model-loaded",
        message: fromSetup
          ? "Candidate model loaded; completing setup warmup and activation"
          : runtime.warmup === "complete"
            ? `${model.name} ready`
            : `${model.name} loaded; warmup not reported complete`,
        speechExecution:
          normalizeSpeechExecution(runtime.speechExecution) ?? null,
        detail: null,
        model: settings.model,
        progress: fromSetup ? null : 1,
        migrationRequired: false,
      });
      if (!fromSetup) this.scheduleSpeechIdle();
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
    if (
      this.status.engine === "ready" &&
      this.status.model === settings.model &&
      this.loadedEngine === speechEngineId(settings)
    )
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
      const loadStarted = performance.now();
      await this.releaseMagicForSpeech(settings);
      await this.ensureLoaded(settings);
      const speechLoadMs = performance.now() - loadStarted;
      this.clearSpeechIdle();
      // A cold load reports "ready"; the dictation is still being transcribed.
      if (this.status.phase !== "transcribing")
        this.updateStatus({
          phase: "transcribing",
          message: "Transcribing locally",
        });
      const capabilities = this.status.capabilities;
      if (!capabilities) {
        throw new Error(
          "Speech capabilities are unavailable. Reload the speech model before recording again.",
        );
      }
      if (
        !capabilities.languageHints.supported ||
        !capabilities.languageHints.languages.includes(settings.language)
      ) {
        const choices = capabilities.languageHints.languages.join(", ");
        throw new Error(
          `The speech adapter does not support language ${settings.language}. ${
            choices
              ? `Choose a supported language in Settings: ${choices}.`
              : "This adapter advertises no language hints; repair the local speech runtime."
          }`,
        );
      }
      const requestStarted = performance.now();
      // Capture this execution before the asynchronous request; future loads must
      // never relabel the transcript produced by the current worker.
      const execution = this.status.speechExecution;
      const result = await this.request<Record<string, unknown>>(
        "speech",
        "transcribe",
        {
          ...payload,
          language: settings.language,
          model: speechEngineId(settings),
        },
        transcriptionTimeout(payload.durationMs),
      );
      const speechRequestMs = performance.now() - requestStarted;
      return {
        ...result,
        timings: normalizeTimings({
          ...normalizeTimings(result.timings),
          speechLoadMs,
          speechRequestMs,
        }),
        speechExecution: execution ? structuredClone(execution) : undefined,
        processingTime: (performance.now() - started) / 1000,
      };
    } finally {
      this.speechOperations -= 1;
      this.scheduleSpeechIdle();
      this.applyDeferredResidency();
    }
  }

  /**
   * Live typing: open a streaming session on the loaded speech model. Returns
   * false when the model cannot stream right now; dictation then stays buffered.
   */
  async liveStart(settings: AppSettings): Promise<boolean> {
    if (usesMetal() || this.shuttingDown) return false;
    this.liveActive = false;
    this.speechOperations += 1;
    this.clearSpeechIdle();
    try {
      await this.releaseMagicForSpeech(settings);
      await this.ensureLoaded(settings);
      await this.request("speech", "streamStart", {
        language: settings.language,
      });
      this.liveActive = true;
      return true;
    } catch {
      return false;
    } finally {
      this.speechOperations -= 1;
    }
  }

  /** Send 16-bit PCM (base64) and receive text that became final. */
  async liveAudio(sampleRate: number, pcm: string): Promise<string> {
    if (!this.liveActive) return "";
    const result = await this.request<{ delta: string }>(
      "speech",
      "streamAudio",
      { pcm, sampleRate: Math.round(sampleRate) },
      30_000,
    );
    return result.delta;
  }

  async liveFinish(): Promise<string> {
    if (!this.liveActive) return "";
    this.liveActive = false;
    try {
      const result = await this.request<{ delta: string }>(
        "speech",
        "streamFinish",
        {},
        60_000,
      );
      return result.delta;
    } catch (error) {
      // A rejected streamFinish can leave a native decoder thread running.
      // Release this worker before buffered transcription reloads the model.
      await this.speechWorker.stopAndWait();
      this.updateStatus({ ...UNLOADED_LIFECYCLE, engine: "unloaded" });
      throw error;
    } finally {
      this.scheduleSpeechIdle();
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
      this.liveActive = false;
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

  async loadMagic(
    settings: AppSettings,
    fromSetup = false,
    eligible: () => boolean = () => true,
  ): Promise<void> {
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
    let operation = this.manualRewrite;
    const guard = () => {
      // A manual rewrite may join a load already awaiting runtime readiness.
      operation ??= this.manualRewrite;
      this.throwIfRewriteCancelled(operation);
    };
    guard();
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
      guard();
      const model = magicModelById(settings.magicModel);
      this.updateMagicStatus({
        phase: "loading",
        engine: "loading",
        setupStage: "model-prepare",
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
      guard();
      this.updateMagicStatus({ capabilities });
      if (!eligible()) return;
      guard();
      const runtime = await this.request<WorkerRuntime>("magic", "magicLoad", {
        model: settings.magicModel,
        cacheDir: this.storage.modelCacheDirectory,
      });
      guard();
      if (!runtime.loaded)
        throw new Error("Writing model load did not report loaded weights");
      if (!eligible()) return;
      this.updateMagicStatus({
        ...reportedLifecycle(runtime),
        phase: fromSetup ? "preparing" : "idle",
        engine: fromSetup ? "settingUp" : "ready",
        setupStage: fromSetup
          ? "warmup"
          : runtime.warmup === "complete"
            ? "ready"
            : "model-loaded",
        message: fromSetup
          ? "Candidate model loaded; completing setup warmup and activation"
          : runtime.warmup === "complete"
            ? `${model.name} ready`
            : `${model.name} loaded; warmup not reported complete`,
        model: settings.magicModel,
        progress: fromSetup ? null : 1,
      });
      guard();
      if (!fromSetup) this.scheduleMagicIdle();
    })()
      .catch(async (error) => {
        operation ??= this.manualRewrite;
        if (operation?.cancelled) {
          await operation.cancelPromise;
          throw new RewriteCancelledError();
        }
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
    operation: ManualRewrite | null = null,
  ): Promise<void> {
    if (!eligible()) return;
    this.throwIfRewriteCancelled(operation);
    if (this.shuttingDown)
      throw new Error("The rewrite model worker is shutting down");
    await this.magicUnloadPromise;
    if (!eligible()) return;
    this.throwIfRewriteCancelled(operation);
    if (this.shuttingDown)
      throw new Error("The rewrite model worker is shutting down");
    if (
      this.magicStatus.engine === "ready" &&
      this.magicStatus.model === settings.magicModel
    )
      return;
    await this.performLoadMagic(settings, false, eligible);
    this.throwIfRewriteCancelled(operation);
  }

  private throwIfRewriteCancelled(operation: ManualRewrite | null): void {
    if (operation?.cancelled) throw new RewriteCancelledError();
  }

  private releaseManualRewrite(operation: ManualRewrite): void {
    if (
      operation.settled &&
      (!operation.cancelled || !operation.cancelPromise) &&
      this.manualRewrite === operation
    )
      this.manualRewrite = null;
  }

  async cancelRewrite(operationId: string): Promise<boolean> {
    const operation = this.manualRewrite;
    if (!operation || operation.id !== operationId || operation.settled)
      return false;
    if (!operation.cancelled) {
      operation.cancelled = true;
      this.clearMagicIdle();
      operation.cancelPromise = Promise.resolve().then(async () => {
        await this.magicWorker.stopAndWait(new RewriteCancelledError());
        this.updateMagicStatus({
          ...UNLOADED_LIFECYCLE,
          phase: "idle",
          engine: "unloaded",
          message: "Rewrite cancelled",
          model: null,
          detail: null,
          progress: null,
        });
      });
    }
    const cleanup = operation.cancelPromise;
    try {
      await cleanup;
    } finally {
      operation.cancelPromise = null;
      this.releaseManualRewrite(operation);
      this.applyDeferredResidency();
    }
    return true;
  }

  async rewriteMagic(
    request: MagicRewriteRequest,
    settings: AppSettings,
  ): Promise<MagicRewriteResult> {
    return this.runModelOperation(settings, () =>
      this.performRewrite(request, settings),
    );
  }

  private async performRewrite(
    request: MagicRewriteRequest,
    settings: AppSettings,
  ): Promise<MagicRewriteResult> {
    const context = normalizeRewriteContext(request.context);
    if (
      this.manualRewrite ||
      (request.operationId !== undefined && this.magicOperations > 0)
    )
      throw new Error("Wait for the active rewrite to finish");
    if (request.operationId !== undefined && !request.operationId.trim())
      throw new Error("Manual rewrite requires a nonempty operation ID");
    const cleanup = request.preset === "spoken-corrections";
    if (cleanup)
      request = {
        ...request,
        allowInferences: false,
        instructions: undefined,
        context: undefined,
      };
    const parts = cleanup
      ? [{ text: request.text, protected: false }]
      : splitTechnicalBlocks(request.text).flatMap((part) =>
          part.protected
            ? [part]
            : splitForRewrite(
                part.text,
                settings.customWords,
                request.sourceLanguage ?? settings.language,
              ),
        );
    if (parts.filter((part) => !part.protected && part.text.trim()).length > 16)
      throw new Error(
        "This text contains too many separate protected blocks or identifiers to rewrite at once. Rewrite a shorter selection.",
      );
    const operation: ManualRewrite | null =
      request.operationId === undefined
        ? null
        : {
            id: request.operationId,
            cancelled: false,
            settled: false,
            cancelPromise: null,
          };
    if (operation) this.manualRewrite = operation;
    this.magicOperations += 1;
    this.clearMagicIdle();
    try {
      this.throwIfRewriteCancelled(operation);
      const loadStarted = performance.now();
      await this.ensureMagicLoaded(settings, () => true, operation);
      const rewriteLoadMs = performance.now() - loadStarted;
      this.throwIfRewriteCancelled(operation);
      this.clearMagicIdle();
      const model = magicModelById(settings.magicModel);
      this.updateMagicStatus({
        phase: "rewriting",
        engine: "ready",
        message: `${model.name} is rewriting`,
        progress: null,
      });
      this.throwIfRewriteCancelled(operation);
      const output: string[] = [];
      let processingTimeMs = 0;
      let rewritingMs = 0;
      for (const part of parts) {
        this.throwIfRewriteCancelled(operation);
        if (part.protected || !part.text.trim()) {
          output.push(part.text);
          continue;
        }
        const requestStarted = performance.now();
        const result = await this.request<
          MagicRewriteResult & Partial<WorkerRuntime>
        >("magic", "magicRewrite", {
          ...request,
          context,
          text: part.text.trim(),
        } as unknown as Record<string, unknown>);
        rewritingMs += performance.now() - requestStarted;
        this.throwIfRewriteCancelled(operation);
        if (
          result.residency !== undefined ||
          result.warmup !== undefined ||
          result.device !== undefined
        ) {
          this.updateMagicStatus({
            ...(result.residency !== undefined
              ? { residency: result.residency }
              : {}),
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
      if (
        cleanup &&
        splitTechnicalBlocks(request.text).some(
          (part) => part.protected && !text.includes(part.text.trim()),
        )
      )
        throw new Error(
          "Cleanup changed a protected code block. Review the original; nothing sent.",
        );
      this.throwIfRewriteCancelled(operation);
      this.updateMagicStatus({
        phase: "idle",
        engine: "ready",
        setupStage:
          this.magicStatus.warmup === "complete" ? "ready" : "model-loaded",
        message:
          this.magicStatus.warmup === "complete"
            ? `${model.name} ready`
            : `${model.name} loaded; warmup not reported complete`,
        progress: 1,
      });
      this.throwIfRewriteCancelled(operation);
      return {
        model: settings.magicModel,
        processingTimeMs,
        timings: normalizeTimings({ rewriteLoadMs, rewritingMs }),
        inputCharacters: request.text.length,
        includedInferences: request.allowInferences,
        preset: request.preset,
        text,
        outputCharacters: text.length,
      };
    } catch (error) {
      if (operation?.cancelled) {
        await operation.cancelPromise;
        throw new RewriteCancelledError();
      }
      this.failMagic(error);
      throw error;
    } finally {
      this.magicOperations -= 1;
      if (operation) {
        operation.settled = true;
        this.releaseManualRewrite(operation);
      }
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
      throw new Error(
        "Wait for rewriting to finish before unloading the rewrite model",
      );
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
            void this.runModelOperation(current, () =>
              this.ensureLoaded(current, eligible),
            ).catch((error) => {
              if (eligible()) this.fail(error);
            });
        })
        .catch((error) => {
          if (eligible()) this.fail(error);
        });
    }
    if (
      settings.preloadMagicModel &&
      settings.memoryPolicy !== "balanced" &&
      this.magicStatus.engine !== "error"
    ) {
      this.clearMagicIdle();
      const generation = this.magicFailureGeneration;
      const eligible = () =>
        !this.shuttingDown &&
        generation === this.magicFailureGeneration &&
        this.magicStatus.engine !== "error";
      void this.isMagicEnvironmentReady()
        .then((ready) => {
          const current = this.storage.getSettings();
          if (
            !ready ||
            !current.preloadMagicModel ||
            current.memoryPolicy === "balanced" ||
            !eligible()
          )
            return;
          if (this.isBusy) this.residencyPending = true;
          else
            void this.runModelOperation(current, () =>
              this.ensureMagicLoaded(current, eligible),
            ).catch((error) => {
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
    if (this.status.idleUnloadAt !== null)
      this.updateStatus({ idleUnloadAt: null });
  }

  private clearMagicIdle(): void {
    if (this.magicIdleTimer) clearTimeout(this.magicIdleTimer);
    this.magicIdleTimer = null;
    if (this.magicStatus.idleUnloadAt !== null)
      this.updateMagicStatus({ idleUnloadAt: null });
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
    this.updateStatus({
      idleUnloadAt: Date.now() + settings.modelIdleMinutes * 60_000,
    });
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
        (this.storage.getSettings().preloadMagicModel &&
          this.storage.getSettings().memoryPolicy !== "balanced") ||
        this.magicStatus.engine !== "ready"
      )
        return;
      if (this.isBusy || !this.canIdleUnload()) this.scheduleMagicIdle();
      else void this.unloadMagic().catch((error) => this.failMagic(error));
    }, settings.modelIdleMinutes * 60_000);
    this.updateMagicStatus({
      idleUnloadAt: Date.now() + settings.modelIdleMinutes * 60_000,
    });
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
    this.liveActive = false;
    this.speechSetup?.controller.abort(
      new Error("Setup cancelled during shutdown"),
    );
    this.magicSetup?.controller.abort(
      new Error("Setup cancelled during shutdown"),
    );
    this.residencyPending = false;
    this.speechInstaller.stop();
    this.magicInstaller.stop();
    this.clearSpeechIdle();
    this.clearMagicIdle();
    await Promise.all([
      this.speechWorker.stopAndWait(),
      this.magicWorker.stopAndWait(),
      this.speechInstaller.stopAndWait(),
      this.magicInstaller.stopAndWait(),
    ]);
    this.updateStatus({ ...UNLOADED_LIFECYCLE });
    this.updateMagicStatus({ ...UNLOADED_LIFECYCLE });
    await Promise.allSettled([this.setupPromise, this.magicSetupPromise]);
  }

  fail(error: unknown): void {
    this.liveActive = false;
    if (error instanceof DomainError && error.cancelled) return;
    this.clearSpeechIdle();
    this.speechFailureGeneration += 1;
    const failure = domainError(error, {
      operationId: randomUUID(),
      operation: "runtime:speech",
    });
    const message = failure.message;
    try {
      if (this.storage.getSettings().keepHistory) {
        writeFileSync(
          join(this.storage.dataDirectory, "last-asr-error.log"),
          privateFailureLog("speech", error, this.speechWorker.stderr),
          { encoding: "utf8", mode: 0o600 },
        );
      }
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
      failure: serializeDomainError(failure),
    });
  }

  failMagic(error: unknown): void {
    if (error instanceof RewriteCancelledError || this.manualRewrite?.cancelled)
      return;
    if (error instanceof DomainError && error.cancelled) return;
    this.clearMagicIdle();
    this.magicFailureGeneration += 1;
    const failure = domainError(error, {
      operationId: randomUUID(),
      operation: "runtime:magic",
    });
    const message = failure.message;
    try {
      if (this.storage.getSettings().keepHistory) {
        writeFileSync(
          join(this.storage.dataDirectory, "last-magic-error.log"),
          privateFailureLog("magic", error, this.magicWorker.stderr),
          { encoding: "utf8", mode: 0o600 },
        );
      }
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
      failure: serializeDomainError(failure),
    });
  }
}
