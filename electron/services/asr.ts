import { splitForRewrite } from "../../src/personalization";
import { app } from "electron";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { magicModelById, modelById } from "../../src/data";
import type {
  AppSettings,
  DictationStatus,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
  RuntimeLifecycle,
} from "../../src/types";
import type { StorageService } from "./storage";

import { WorkerClient, transcriptionTimeout } from "../runtime/workerClient";
import { SerialQueue } from "../runtime/serialQueue";
import { RuntimeInstaller } from "../runtime/installer";
import { speechModelForPlatform } from "../runtime/platform";

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
    ? { residency: "unknown", warmup: "unknown", device: null, idleUnloadAt: null }
    : UNLOADED_LIFECYCLE;
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
    "The speech engine stopped unexpectedly"
  ).slice(0, 800);
}

export class AsrService {
  private readonly speechWorker: WorkerClient;
  private readonly magicWorker: WorkerClient;
  private readonly speechInstaller: RuntimeInstaller;
  private readonly magicInstaller: RuntimeInstaller;
  private readonly maintenance = new SerialQueue();
  private initializing = false;
  get isBusy(): boolean {
    return (
      this.initializing ||
      this.maintenance.busy ||
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
    message: "Local engine setup required",
    progress: null,
  };
  private statusListeners = new Set<(status: DictationStatus) => void>();
  private magicStatus: MagicStatus = {
    ...UNLOADED_LIFECYCLE,
    phase: "idle",
    engine: "missing",
    message: "Magic setup required",
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
      },
      null,
      () => this.workerEnvironment("speech"),
    );
    this.magicInstaller = new RuntimeInstaller(
      {
        dataDirectory: storage.dataDirectory,
        venvDirectory: storage.magicVenvDirectory,
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

  setRecovery(available: boolean): void {
    this.updateStatus({ retryAvailable: available });
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
      message: "Checking your local speech engine…",
    });
    this.updateMagicStatus({
      phase: "loading",
      engine: "unloaded",
      message: "Checking your local writing engine…",
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
              ? "Preparing selected model"
              : "Engine installed — model loads on demand",
            migrationRequired: false,
          }
        : {
            phase: "idle",
            engine: "missing",
            message: migrationRequired
              ? "Speech runtime update required"
              : "Local engine setup required",
            migrationRequired,
          },
    );
    this.updateMagicStatus(
      magicReady
        ? {
            phase: "idle",
            engine: "unloaded",
            message: settings.magicEnabled
              ? "Magic installed — model loads on demand"
              : "Writing available on demand",
          }
        : { phase: "idle", engine: "missing", message: "Magic setup required" },
    );
    if (ready && settings.preloadModel) {
      void this.loadModel(settings).catch((error) => this.fail(error));
    }
    if (magicReady && settings.preloadMagicModel) {
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
      .catch(async (error) => {
        this.fail(error);
        if (await this.isEnvironmentReady())
          this.updateStatus({
            phase: "idle",
            engine: "unloaded",
            message:
              "Setup failed; your existing runtime is preserved. Load it to continue, or retry Repair.",
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
    const reloadMagic =
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
      message: "Downloading and loading the selected model",
      progress: 0.82,
    });
    try {
      await this.loadModel(settings, true);
    } catch (error) {
      await this.speechWorker.stopAndWait();
      this.speechInstaller.rollback();
      throw error;
    }
    if (reloadMagic && this.magicStatus.engine !== "ready") {
      await this.loadMagic(settings, true);
    }
  }

  async setupMagic(settings: AppSettings): Promise<void> {
    if (this.magicSetupPromise) return this.magicSetupPromise;
    this.shuttingDown = false;
    this.magicSetupPromise = this.maintenance
      .run(() => this.performMagicSetup(settings))
      .catch(async (error) => {
        this.failMagic(error);
        if (await this.isMagicEnvironmentReady())
          this.updateMagicStatus({
            phase: "idle",
            engine: "unloaded",
            message:
              "Setup failed; your existing Writing runtime is preserved. Load it to continue, or retry Repair.",
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
      message: `Downloading and loading ${model.name}`,
      progress: 0.82,
    });
    try {
      await this.loadMagic(settings, true);
    } catch (error) {
      await this.magicWorker.stopAndWait();
      this.magicInstaller.rollback();
      throw error;
    }
    if (reloadSpeech && this.status.engine !== "ready")
      await this.loadModel(settings, true);
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
    const modelCache = this.storage.modelCacheDirectory;
    return {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      HF_HOME: modelCache,
      HF_HUB_CACHE: join(modelCache, "hub"),
      HUGGINGFACE_HUB_CACHE: join(modelCache, "hub"),
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };
  }

  private request<T>(
    kind: "speech" | "magic",
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (this.shuttingDown)
      return Promise.reject(new Error("The model engines are shutting down"));
    const worker = kind === "speech" ? this.speechWorker : this.magicWorker;
    return worker.request<T>(command, payload, timeoutMs);
  }

  async loadModel(settings: AppSettings, fromSetup = false): Promise<void> {
    if (this.shuttingDown)
      throw new Error("The speech engine is shutting down");
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
    if (this.loadPromise) return this.loadPromise;
    this.clearSpeechIdle();
    this.loadPromise = (async () => {
      await this.speechUnloadPromise;
      if (!fromSetup && !(await this.isEnvironmentReady()))
        throw new Error(
          "Local engine setup is required before loading a model",
        );
      const model = modelById(settings.model);
      this.updateStatus({
        phase: "loading",
        engine: "loading",
        residency: "loading",
        warmup: "unknown",
        device: null,
        message: `Loading and warming up ${model.name}. Ready means speech inference has been exercised, not just the weights loaded.`,
        model: settings.model,
        progress: 0.85,
      });
      const runtime = await this.request<WorkerRuntime>("speech", "load", {
        cacheDir: this.storage.modelCacheDirectory,
      });
      if (!runtime.loaded) throw new Error("Speech model load did not report loaded weights");
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
        await this.speechWorker.stopAndWait();
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.loadPromise = null;
        this.applyDeferredResidency();
      });
    return this.loadPromise;
  }

  async ensureLoaded(settings: AppSettings): Promise<void> {
    if (this.shuttingDown)
      throw new Error("The speech engine is shutting down");
    await this.speechUnloadPromise;
    if (this.shuttingDown)
      throw new Error("The speech engine is shutting down");
    if (this.status.engine === "ready" && this.status.model === settings.model)
      return;
    await this.loadModel(settings);
  }

  async transcribe(
    payload: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<Record<string, unknown>> {
    const started = performance.now();
    this.speechOperations += 1;
    this.clearSpeechIdle();
    try {
      await this.ensureLoaded(settings);
      this.clearSpeechIdle();
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
      this.configureResidency(this.storage.getSettings());
    }
  }

  async unload(): Promise<void> {
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
        message: "Model unloaded",
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

  async loadMagic(settings: AppSettings, fromSetup = false): Promise<void> {
    if (this.shuttingDown)
      throw new Error("The writing engine is shutting down");
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
    if (this.magicLoadPromise) return this.magicLoadPromise;
    this.clearMagicIdle();
    this.magicLoadPromise = (async () => {
      await this.magicUnloadPromise;
      if (!fromSetup && !(await this.isMagicEnvironmentReady()))
        throw new Error("Install the Magic runtime before loading a model");
      const model = magicModelById(settings.magicModel);
      this.updateMagicStatus({
        phase: "loading",
        engine: "loading",
        residency: "loading",
        warmup: "unknown",
        device: null,
        message: `Loading ${model.name}`,
        model: settings.magicModel,
        progress: 0.86,
      });
      const runtime = await this.request<WorkerRuntime>(
        "magic",
        "magicLoad",
        {
          model: settings.magicModel,
          cacheDir: this.storage.modelCacheDirectory,
        },
      );
      if (!runtime.loaded) throw new Error("Writing model load did not report loaded weights");
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
        this.failMagic(error);
        throw error;
      })
      .finally(() => {
        this.magicLoadPromise = null;
        this.applyDeferredResidency();
      });
    return this.magicLoadPromise;
  }

  async ensureMagicLoaded(settings: AppSettings): Promise<void> {
    if (this.shuttingDown)
      throw new Error("The writing engine is shutting down");
    await this.magicUnloadPromise;
    if (this.shuttingDown)
      throw new Error("The writing engine is shutting down");
    if (
      this.magicStatus.engine === "ready" &&
      this.magicStatus.model === settings.magicModel
    )
      return;
    await this.loadMagic(settings);
  }

  async rewriteMagic(
    request: MagicRewriteRequest,
    settings: AppSettings,
  ): Promise<MagicRewriteResult> {
    const parts = splitForRewrite(request.text, settings.customWords);
    if (parts.filter((part) => !part.protected && part.text.trim()).length > 16)
      throw new Error(
        "This text contains too many separate shortcut blocks to rewrite at once. Rewrite a shorter selection.",
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
      this.configureResidency(this.storage.getSettings());
    }
  }

  async unloadMagic(): Promise<void> {
    if (this.magicUnloadPromise) return this.magicUnloadPromise;
    if (
      this.magicWorker.busy ||
      this.magicLoadPromise ||
      this.magicOperations > 0 ||
      !this.canIdleUnload()
    )
      throw new Error("Wait for Writing to finish before unloading");
    this.clearMagicIdle();
    this.magicUnloadPromise = (async () => {
      this.updateMagicStatus({ residency: "unloading", idleUnloadAt: null });
      await this.magicWorker.stopAndWait();
      this.updateMagicStatus({
        phase: "idle",
        engine: existsSync(this.magicInstaller.python) ? "unloaded" : "missing",
        message: "Magic model unloaded",
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
    if (settings.preloadModel) {
      this.clearSpeechIdle();
      void this.isEnvironmentReady().then((ready) => {
        const current = this.storage.getSettings();
        if (!ready || !current.preloadModel || this.shuttingDown) return;
        if (this.isBusy) this.residencyPending = true;
        else void this.ensureLoaded(current).catch((error) => this.fail(error));
      });
    }
    if (settings.preloadMagicModel) {
      this.clearMagicIdle();
      void this.isMagicEnvironmentReady().then((ready) => {
        const current = this.storage.getSettings();
        if (!ready || !current.preloadMagicModel || this.shuttingDown) return;
        if (this.isBusy) this.residencyPending = true;
        else
          void this.ensureMagicLoaded(current).catch((error) =>
            this.failMagic(error),
          );
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
      settings.preloadMagicModel ||
      this.magicStatus.engine !== "ready"
    )
      return;
    this.magicIdleTimer = setTimeout(() => {
      this.magicIdleTimer = null;
      this.updateMagicStatus({ idleUnloadAt: null });
      if (
        this.shuttingDown ||
        this.storage.getSettings().preloadMagicModel ||
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
      message: "Local Python environment removed",
      model: null,
      progress: null,
      migrationRequired: false,
    });
    this.updateMagicStatus({
      phase: "idle",
      engine: "missing",
      message: "Magic setup required",
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
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeFileSync(
        join(this.storage.dataDirectory, "last-asr-error.log"),
        `${this.speechWorker.stderr}\n${message}\n`,
        "utf8",
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
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeFileSync(
        join(this.storage.dataDirectory, "last-magic-error.log"),
        `${this.magicWorker.stderr}\n${message}\n`,
        "utf8",
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
