import { app } from "electron";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { magicModelById, modelById } from "../../src/data";
import type {
  AppSettings,
  DictationStatus,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
} from "../../src/types";
import type { StorageService } from "./storage";

import { WorkerClient } from "../runtime/workerClient";
import { SerialQueue } from "../runtime/serialQueue";
import { RuntimeInstaller } from "../runtime/installer";

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
  private readonly worker: WorkerClient;
  private readonly installer: RuntimeInstaller;
  private readonly maintenance = new SerialQueue();
  private initializing = false;
  get isBusy(): boolean {
    return (
      this.initializing ||
      this.maintenance.busy ||
      this.worker.busy ||
      !!this.loadPromise ||
      !!this.magicLoadPromise
    );
  }
  private get stderr(): string {
    return this.worker.stderr;
  }
  private status: DictationStatus = {
    phase: "idle",
    engine: "missing",
    message: "Local engine setup required",
    progress: null,
  };
  private statusListeners = new Set<(status: DictationStatus) => void>();
  private magicStatus: MagicStatus = {
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
  private speechIdleTimer: NodeJS.Timeout | null = null;
  private magicIdleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly storage: StorageService) {
    this.installer = new RuntimeInstaller(
      storage,
      app.isPackaged
        ? join(process.resourcesPath, "python/constraints-linux-x64.txt")
        : resolve(
            app.getAppPath(),
            "electron/python/constraints-linux-x64.txt",
          ),
      () => this.workerEnvironment(),
    );
    this.worker = new WorkerClient(
      () => ({
        python: this.venvPython(),
        script: this.scriptPath(),
        env: this.workerEnvironment(),
      }),
      (error) => {
        this.fail(error);
        this.failMagic(error);
      },
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
    this.status = { ...this.status, ...patch };
    for (const listener of this.statusListeners) listener(this.getStatus());
  }

  private updateMagicStatus(patch: Partial<MagicStatus>): void {
    this.magicStatus = { ...this.magicStatus, ...patch };
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
    return this.installer.python;
  }

  async initialize(settings: AppSettings): Promise<void> {
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
          }
        : {
            phase: "idle",
            engine: "missing",
            message: "Local engine setup required",
          },
    );
    this.updateMagicStatus(
      magicReady
        ? {
            phase: "idle",
            engine: "unloaded",
            message: settings.magicEnabled
              ? "Magic installed — model loads on demand"
              : "Magic is disabled",
          }
        : { phase: "idle", engine: "missing", message: "Magic setup required" },
    );
    if (ready && settings.preloadModel && settings.modelLicenseAccepted) {
      void this.loadModel(settings).catch((error) => this.fail(error));
    }
    if (magicReady && settings.magicEnabled && settings.preloadMagicModel) {
      void this.loadMagic(settings).catch((error) => this.failMagic(error));
    }
  }

  async isEnvironmentReady(): Promise<boolean> {
    return this.installer.ready("speech");
  }
  async isMagicEnvironmentReady(): Promise<boolean> {
    return this.installer.ready("magic");
  }

  async setup(settings: AppSettings): Promise<void> {
    if (!settings.modelLicenseAccepted) {
      throw new Error(
        "Accept the Nyra model-weight license before downloading a model",
      );
    }
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = this.maintenance
      .run(() => this.performSetup(settings))
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.setupPromise = null;
      });
    return this.setupPromise;
  }

  private async performSetup(settings: AppSettings): Promise<void> {
    const reloadMagic =
      settings.magicEnabled &&
      settings.preloadMagicModel &&
      (await this.isMagicEnvironmentReady());
    if (this.worker.running) {
      await this.shutdown();
      this.updateMagicStatus({
        phase: "idle",
        engine: "unloaded",
        message: "Magic model will reload after speech setup",
        model: null,
        device: null,
        progress: null,
      });
    }
    await this.installer.install("speech", settings, (progress) =>
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
    await this.loadModel(settings, true);
    if (reloadMagic) {
      await this.loadMagic(settings, true);
    }
  }

  async setupMagic(settings: AppSettings): Promise<void> {
    if (!settings.magicEnabled)
      throw new Error(
        "Magic is turned off. Enable it before installing a model",
      );
    if (this.magicSetupPromise) return this.magicSetupPromise;
    this.magicSetupPromise = this.maintenance
      .run(() => this.performMagicSetup(settings))
      .catch((error) => {
        this.failMagic(error);
        throw error;
      })
      .finally(() => {
        this.magicSetupPromise = null;
      });
    return this.magicSetupPromise;
  }

  private async performMagicSetup(settings: AppSettings): Promise<void> {
    const reloadSpeech =
      settings.preloadModel &&
      settings.modelLicenseAccepted &&
      (await this.isEnvironmentReady());
    if (this.worker.running) {
      await this.shutdown();
      this.updateStatus({
        phase: "idle",
        engine: "unloaded",
        message: "Speech model will reload after Magic setup",
        model: null,
        backend: null,
        progress: null,
      });
    }
    await this.installer.install("magic", settings, (progress) =>
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
    await this.loadMagic(settings, true);
    if (reloadSpeech) await this.loadModel(settings, true);
  }

  private workerEnvironment(): NodeJS.ProcessEnv {
    const bin =
      process.platform === "win32"
        ? join(this.storage.venvDirectory, "Scripts")
        : join(this.storage.venvDirectory, "bin");
    const modelCache = this.storage.modelCacheDirectory;
    return {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      CRISPERWHISPER_CACHE: modelCache,
      HF_HOME: modelCache,
      HF_HUB_CACHE: join(modelCache, "hub"),
      HUGGINGFACE_HUB_CACHE: join(modelCache, "hub"),
      TRANSFORMERS_CACHE: join(modelCache, "transformers"),
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };
  }

  private request<T>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.worker.request<T>(command, payload, timeoutMs);
  }

  async loadModel(settings: AppSettings, fromSetup = false): Promise<void> {
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
    if (!settings.modelLicenseAccepted)
      throw new Error(
        "Accept the Nyra model-weight license before loading a model",
      );
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      if (!fromSetup && !(await this.isEnvironmentReady()))
        throw new Error(
          "Local engine setup is required before loading a model",
        );
      const model = modelById(settings.model);
      this.updateStatus({
        phase: "loading",
        engine: "loading",
        message: `Loading ${model.name}`,
        model: settings.model,
        progress: 0.85,
      });
      const runtime = await this.request<{ backend: "ct2" | "transformers" }>(
        "load",
        {
          model: model.shorthand,
          backend: settings.backend,
          computeType: settings.computeType,
          speculativeDecoding: settings.speculativeDecoding,
          cacheDir: this.storage.modelCacheDirectory,
        },
      );
      this.updateStatus({
        phase: "idle",
        engine: "ready",
        message: `${model.name} ready`,
        model: settings.model,
        backend: runtime.backend,
        progress: 1,
      });
      this.scheduleSpeechIdle(settings);
    })()
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  async ensureLoaded(settings: AppSettings): Promise<void> {
    if (this.status.engine === "ready" && this.status.model === settings.model)
      return;
    await this.loadModel(settings);
  }

  async transcribe(
    payload: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<Record<string, unknown>> {
    this.clearSpeechIdle();
    await this.ensureLoaded(settings);
    this.clearSpeechIdle();
    try {
      return await this.request<Record<string, unknown>>("transcribe", {
        ...payload,
        language: settings.language,
        mode: payload.mode ?? settings.transcriptionMode,
        wordTimestamps: settings.wordTimestamps,
        speculativeDecoding: settings.speculativeDecoding,
        customWords: settings.customWords,
      });
    } finally {
      this.scheduleSpeechIdle(settings);
    }
  }

  async runTool(
    command: "verbatimize" | "forcedAlign",
    payload: Record<string, unknown>,
    settings: AppSettings,
  ): Promise<Record<string, unknown>> {
    this.clearSpeechIdle();
    await this.ensureLoaded(settings);
    this.clearSpeechIdle();
    try {
      return await this.request<Record<string, unknown>>(command, {
        ...payload,
        language: settings.language,
        wordTimestamps: settings.wordTimestamps,
        customWords: settings.customWords,
      });
    } finally {
      this.scheduleSpeechIdle(settings);
    }
  }

  async unload(): Promise<void> {
    this.clearSpeechIdle();
    if (this.worker.running) {
      try {
        await this.request("unload", {}, 60_000);
      } catch {
        /* worker may already be gone */
      }
    }
    this.updateStatus({
      phase: "idle",
      engine: existsSync(this.venvPython()) ? "unloaded" : "missing",
      message: "Model unloaded",
      model: null,
      backend: null,
      progress: null,
    });
  }

  async loadMagic(settings: AppSettings, fromSetup = false): Promise<void> {
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
    if (!settings.magicEnabled)
      throw new Error("Magic is turned off. Enable it before loading a model");
    if (this.magicLoadPromise) return this.magicLoadPromise;
    this.magicLoadPromise = (async () => {
      if (!fromSetup && !(await this.isMagicEnvironmentReady()))
        throw new Error("Install the Magic runtime before loading a model");
      const model = magicModelById(settings.magicModel);
      this.updateMagicStatus({
        phase: "loading",
        engine: "loading",
        message: `Loading ${model.name}`,
        model: settings.magicModel,
        progress: 0.86,
      });
      const runtime = await this.request<{ device: string }>("magicLoad", {
        model: settings.magicModel,
        cacheDir: this.storage.modelCacheDirectory,
      });
      this.updateMagicStatus({
        phase: "idle",
        engine: "ready",
        message: `${model.name} ready`,
        model: settings.magicModel,
        device: runtime.device,
        progress: 1,
      });
      this.scheduleMagicIdle(settings);
    })()
      .catch((error) => {
        this.failMagic(error);
        throw error;
      })
      .finally(() => {
        this.magicLoadPromise = null;
      });
    return this.magicLoadPromise;
  }

  async ensureMagicLoaded(settings: AppSettings): Promise<void> {
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
    this.clearMagicIdle();
    await this.ensureMagicLoaded(settings);
    this.clearMagicIdle();
    const model = magicModelById(settings.magicModel);
    this.updateMagicStatus({
      phase: "rewriting",
      engine: "ready",
      message: `${model.name} is rewriting`,
      progress: null,
    });
    try {
      const result = await this.request<MagicRewriteResult>(
        "magicRewrite",
        request as unknown as Record<string, unknown>,
      );
      this.updateMagicStatus({
        phase: "idle",
        engine: "ready",
        message: `${model.name} ready`,
        progress: 1,
      });
      return result;
    } catch (error) {
      this.failMagic(error);
      throw error;
    } finally {
      this.scheduleMagicIdle(settings);
    }
  }

  async unloadMagic(): Promise<void> {
    this.clearMagicIdle();
    if (this.worker.running) {
      try {
        await this.request("magicUnload", {}, 60_000);
      } catch {
        /* worker may already be gone */
      }
    }
    this.updateMagicStatus({
      phase: "idle",
      engine: existsSync(this.venvPython()) ? "unloaded" : "missing",
      message: "Magic model unloaded",
      model: null,
      device: null,
      progress: null,
    });
  }

  configureResidency(settings: AppSettings): void {
    if (this.isBusy) return;
    if (settings.preloadModel && settings.modelLicenseAccepted) {
      this.clearSpeechIdle();
      void this.isEnvironmentReady().then((ready) => {
        if (ready)
          void this.ensureLoaded(settings).catch((error) => this.fail(error));
      });
    } else {
      this.scheduleSpeechIdle(settings);
    }
    if (!settings.magicEnabled) {
      void this.unloadMagic();
    } else if (settings.preloadMagicModel) {
      this.clearMagicIdle();
      void this.isMagicEnvironmentReady().then((ready) => {
        if (ready)
          void this.ensureMagicLoaded(settings).catch((error) =>
            this.failMagic(error),
          );
      });
    } else {
      this.scheduleMagicIdle(settings);
    }
  }

  private clearSpeechIdle(): void {
    if (this.speechIdleTimer) clearTimeout(this.speechIdleTimer);
    this.speechIdleTimer = null;
  }

  private clearMagicIdle(): void {
    if (this.magicIdleTimer) clearTimeout(this.magicIdleTimer);
    this.magicIdleTimer = null;
  }

  private scheduleSpeechIdle(settings: AppSettings): void {
    this.clearSpeechIdle();
    if (settings.preloadModel || this.status.engine !== "ready") return;
    this.speechIdleTimer = setTimeout(
      () => void this.unload(),
      settings.modelIdleMinutes * 60_000,
    );
  }

  private scheduleMagicIdle(settings: AppSettings): void {
    this.clearMagicIdle();
    if (
      settings.preloadMagicModel ||
      !settings.magicEnabled ||
      this.magicStatus.engine !== "ready"
    )
      return;
    this.magicIdleTimer = setTimeout(
      () => void this.unloadMagic(),
      settings.modelIdleMinutes * 60_000,
    );
  }

  async reset(): Promise<void> {
    await this.shutdown();
    if (existsSync(this.storage.venvDirectory))
      rmSync(this.storage.venvDirectory, { recursive: true, force: true });
    this.updateStatus({
      phase: "idle",
      engine: "missing",
      message: "Local Python environment removed",
      model: null,
      backend: null,
      progress: null,
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
    this.installer.stop();
    this.clearSpeechIdle();
    this.clearMagicIdle();
    this.worker.stop();
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeFileSync(
        join(this.storage.dataDirectory, "last-asr-error.log"),
        `${this.stderr}\n${message}\n`,
        "utf8",
      );
    } catch {
      /* diagnostics are best-effort */
    }
    this.updateStatus({
      phase: "error",
      engine: "error",
      message: conciseError(message),
      detail: message,
      progress: null,
    });
  }

  failMagic(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      writeFileSync(
        join(this.storage.dataDirectory, "last-magic-error.log"),
        `${this.stderr}\n${message}\n`,
        "utf8",
      );
    } catch {
      /* diagnostics are best-effort */
    }
    this.updateMagicStatus({
      phase: "error",
      engine: "error",
      message: conciseError(message),
      detail: message,
      progress: null,
    });
  }
}
