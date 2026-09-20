import { splitForRewrite } from "../../src/personalization";
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
      !!this.magicLoadPromise
    );
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
    );
    this.magicWorker = new WorkerClient(
      () => ({
        python: this.magicInstaller.python,
        script: this.scriptPath(),
        env: this.workerEnvironment("magic"),
      }),
      (error) => this.failMagic(error),
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
    return this.speechInstaller.python;
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
      settings.preloadMagicModel && (await this.isMagicEnvironmentReady());
    if (this.speechWorker.running) this.speechWorker.stop();
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
    await this.loadModel(settings, true);
    if (reloadMagic && this.magicStatus.engine !== "ready") {
      await this.loadMagic(settings, true);
    }
  }

  async setupMagic(settings: AppSettings): Promise<void> {
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
      settings.preloadModel && (await this.isEnvironmentReady());
    if (this.magicWorker.running) this.magicWorker.stop();
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
    await this.loadMagic(settings, true);
    if (reloadSpeech && this.status.engine !== "ready")
      await this.loadModel(settings, true);
  }

  private workerEnvironment(kind: "speech" | "magic"): NodeJS.ProcessEnv {
    const venvDirectory =
      kind === "speech"
        ? this.storage.venvDirectory
        : this.storage.magicVenvDirectory;
    const bin =
      process.platform === "win32"
        ? join(venvDirectory, "Scripts")
        : join(venvDirectory, "bin");
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
    const worker = kind === "speech" ? this.speechWorker : this.magicWorker;
    return worker.request<T>(command, payload, timeoutMs);
  }

  async loadModel(settings: AppSettings, fromSetup = false): Promise<void> {
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
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
      await this.request("speech", "load", {
        cacheDir: this.storage.modelCacheDirectory,
      });
      this.updateStatus({
        phase: "idle",
        engine: "ready",
        message: `${model.name} ready`,
        model: settings.model,
        progress: 1,
        migrationRequired: false,
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
      return await this.request<Record<string, unknown>>(
        "speech",
        "transcribe",
        {
          ...payload,
          language: settings.language,
        },
      );
    } finally {
      this.scheduleSpeechIdle(settings);
    }
  }

  async unload(): Promise<void> {
    this.clearSpeechIdle();
    if (this.speechWorker.running) {
      try {
        await this.request("speech", "unload", {}, 60_000);
      } catch {
        /* worker may already be gone */
      }
    }
    this.updateStatus({
      phase: "idle",
      engine: existsSync(this.venvPython()) ? "unloaded" : "missing",
      message: "Model unloaded",
      model: null,
      progress: null,
    });
  }

  async loadMagic(settings: AppSettings, fromSetup = false): Promise<void> {
    if (!fromSetup && this.maintenance.busy)
      throw new Error("Wait for runtime setup to finish");
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
      const runtime = await this.request<{ device: string }>(
        "magic",
        "magicLoad",
        {
          model: settings.magicModel,
          cacheDir: this.storage.modelCacheDirectory,
        },
      );
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
    const parts = splitForRewrite(request.text, settings.customWords);
    if (parts.filter((part) => !part.protected && part.text.trim()).length > 16)
      throw new Error(
        "This text contains too many separate shortcut blocks to rewrite at once. Rewrite a shorter selection.",
      );
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
      const output: string[] = [];
      let processingTimeMs = 0;
      for (const part of parts) {
        if (part.protected || !part.text.trim()) {
          output.push(part.text);
          continue;
        }
        const result = await this.request<MagicRewriteResult>(
          "magic",
          "magicRewrite",
          {
            ...request,
            text: part.text.trim(),
          } as unknown as Record<string, unknown>,
        );
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
        message: `${model.name} ready`,
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
      this.scheduleMagicIdle(settings);
    }
  }

  async unloadMagic(): Promise<void> {
    this.clearMagicIdle();
    if (this.magicWorker.running) {
      try {
        await this.request("magic", "magicUnload", {}, 60_000);
      } catch {
        /* worker may already be gone */
      }
    }
    this.updateMagicStatus({
      phase: "idle",
      engine: existsSync(this.magicInstaller.python) ? "unloaded" : "missing",
      message: "Magic model unloaded",
      model: null,
      device: null,
      progress: null,
    });
  }

  configureResidency(settings: AppSettings): void {
    if (this.isBusy) return;
    if (settings.preloadModel) {
      this.clearSpeechIdle();
      void this.isEnvironmentReady().then((ready) => {
        if (ready)
          void this.ensureLoaded(settings).catch((error) => this.fail(error));
      });
    } else {
      this.scheduleSpeechIdle(settings);
    }
    if (settings.preloadMagicModel) {
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
    if (settings.preloadMagicModel || this.magicStatus.engine !== "ready")
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
    this.speechInstaller.stop();
    this.magicInstaller.stop();
    this.clearSpeechIdle();
    this.clearMagicIdle();
    this.speechWorker.stop();
    this.magicWorker.stop();
  }

  fail(error: unknown): void {
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
        `${this.magicWorker.stderr}\n${message}\n`,
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
