import { app } from "electron";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { modelById } from "../../src/data";
import type { AppSettings, DictationStatus } from "../../src/types";
import type { StorageService } from "./storage";

const PROTOCOL_PREFIX = "@delulu:";
const READY_CHECK = "import crisperwhisper; print(crisperwhisper.__version__)";

type WorkerResponse = { id: string; ok: boolean; result?: unknown; error?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };

function splitCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
}

function conciseError(value: string): string {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) =>
    !line.includes("unauthenticated requests")
    && !line.includes("Loading weights")
    && !/^\d+%\|/.test(line),
  );
  return (useful.at(-1) ?? lines.at(-1) ?? "The speech engine stopped unexpectedly").slice(0, 800);
}

export class AsrService {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private stderr = "";
  private status: DictationStatus = {
    phase: "idle",
    engine: "missing",
    message: "Local engine setup required",
    progress: null,
  };
  private statusListeners = new Set<(status: DictationStatus) => void>();
  private setupPromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly storage: StorageService) {}

  onStatus(listener: (status: DictationStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): DictationStatus {
    return structuredClone(this.status);
  }

  setActivity(phase: DictationStatus["phase"], message: string, detail?: string): void {
    this.updateStatus({ phase, message, detail: detail ?? null });
  }

  private updateStatus(patch: Partial<DictationStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.statusListeners) listener(this.getStatus());
  }

  private scriptPath(): string {
    const packaged = join(process.resourcesPath, "python", "transcription_engine.py");
    if (app.isPackaged && existsSync(packaged)) return packaged;
    return resolve(app.getAppPath(), "electron", "python", "transcription_engine.py");
  }

  private venvPython(): string {
    return process.platform === "win32"
      ? join(this.storage.venvDirectory, "Scripts", "python.exe")
      : join(this.storage.venvDirectory, "bin", "python");
  }

  private pythonCandidates(settings: AppSettings): string[][] {
    const configured = splitCommand(settings.pythonCommand);
    const generic = ["python", "python3"].includes(configured[0] ?? "");
    const fallbacks = process.platform === "win32"
      ? [["py", "-3.12"], ["py", "-3.11"], ["python3.12"], ["python3.11"]]
      : [["python3.13"], ["python3.12"], ["python3.11"], ["python3.10"]];
    return generic ? [...fallbacks, configured] : [configured];
  }

  private resolveBasePython(settings: AppSettings): string[] {
    const errors: string[] = [];
    for (const candidate of this.pythonCandidates(settings)) {
      if (!candidate.length) continue;
      const check = spawnSync(candidate[0], [...candidate.slice(1), "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      if (check.status === 0) {
        const [major, minor] = check.stdout.trim().split(".").map(Number);
        if (major === 3 && minor >= 10 && minor <= 13) return candidate;
        errors.push(`${candidate.join(" ")} is Python ${check.stdout.trim()}; supported releases are 3.10–3.13`);
      } else {
        errors.push(`${candidate.join(" ")} unavailable`);
      }
    }
    throw new Error(`No compatible Python found. Install Python 3.11 or 3.12, or set its full path. ${errors.join("; ")}`);
  }

  async initialize(settings: AppSettings): Promise<void> {
    const ready = await this.isEnvironmentReady();
    this.updateStatus(ready
      ? { phase: "idle", engine: "unloaded", message: settings.preloadModel ? "Preparing selected model" : "Engine installed — model loads on demand" }
      : { phase: "idle", engine: "missing", message: "Local engine setup required" });
    if (ready && settings.preloadModel && settings.modelLicenseAccepted) {
      void this.loadModel(settings).catch((error) => this.fail(error));
    }
  }

  async isEnvironmentReady(): Promise<boolean> {
    const python = this.venvPython();
    if (!existsSync(python)) return false;
    return new Promise((resolveReady) => {
      const child = spawn(python, ["-c", READY_CHECK], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => child.kill(), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveReady(code === 0);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolveReady(false);
      });
    });
  }

  async setup(settings: AppSettings): Promise<void> {
    if (!settings.modelLicenseAccepted) {
      throw new Error("Accept the Nyra model-weight license in Settings before downloading a model");
    }
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = this.performSetup(settings).finally(() => { this.setupPromise = null; });
    return this.setupPromise;
  }

  private async performSetup(settings: AppSettings): Promise<void> {
    this.updateStatus({ phase: "preparing", engine: "settingUp", message: "Creating isolated Python environment", progress: 0.05 });
    mkdirSync(this.storage.dataDirectory, { recursive: true });
    if (!existsSync(this.venvPython())) {
      const python = this.resolveBasePython(settings);
      await this.runProcess(python[0], [...python.slice(1), "-m", "venv", this.storage.venvDirectory], "Creating Python environment", 0.12);
    }
    await this.runProcess(this.venvPython(), ["-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools"], "Updating the local package installer", 0.22);

    const wantsCt2 = settings.backend === "ct2" || (settings.backend === "auto" && process.platform === "linux" && process.arch === "x64");
    if (wantsCt2 && !(process.platform === "linux" && process.arch === "x64")) {
      throw new Error("The CrisperWhisper CTranslate2 runtime currently provides wheels for Linux x64; choose Transformers on this platform");
    }
    const packageName = wantsCt2 ? "crisperwhisper[ct2,convert]" : "crisperwhisper[transformers]";
    await this.runProcess(this.venvPython(), ["-m", "pip", "install", "--upgrade", packageName], `Installing ${wantsCt2 ? "CTranslate2 + conversion" : "Transformers"} runtime`, 0.45);
    this.updateStatus({ phase: "loading", engine: "loading", message: "Downloading and loading the selected model", progress: 0.82 });
    await this.loadModel(settings, true);
  }

  private runProcess(program: string, args: string[], label: string, progress: number): Promise<void> {
    this.updateStatus({ phase: "preparing", engine: "settingUp", message: label, progress });
    return new Promise((resolveProcess, reject) => {
      const child = spawn(program, args, { windowsHide: true, env: this.workerEnvironment() });
      let errorOutput = "";
      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        errorOutput = `${errorOutput}${text}`.slice(-40_000);
        const finalLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
        if (finalLine && !/^\d+%\|/.test(finalLine)) this.updateStatus({ message: `${label}: ${finalLine.slice(0, 180)}` });
      };
      child.stdout.on("data", handleOutput);
      child.stderr.on("data", handleOutput);
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveProcess() : reject(new Error(`${label} failed: ${conciseError(errorOutput)}`)));
    });
  }

  private workerEnvironment(): NodeJS.ProcessEnv {
    const bin = process.platform === "win32" ? join(this.storage.venvDirectory, "Scripts") : join(this.storage.venvDirectory, "bin");
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

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker && !this.worker.killed) return this.worker;
    const python = this.venvPython();
    if (!existsSync(python)) throw new Error("Local speech engine is not installed yet");
    this.stderr = "";
    const child = spawn(python, ["-u", this.scriptPath()], {
      windowsHide: true,
      env: this.workerEnvironment(),
    });
    this.worker = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.startsWith(PROTOCOL_PREFIX)) return;
      try {
        const response = JSON.parse(line.slice(PROTOCOL_PREFIX.length)) as WorkerResponse;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(response.id);
        response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error || "Speech worker request failed"));
      } catch (error) {
        this.fail(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-80_000);
    });
    child.once("exit", (code) => {
      if (this.worker !== child) return;
      this.worker = null;
      const error = new Error(code === 0 ? "Speech worker closed" : conciseError(this.stderr));
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      if (code !== 0) this.fail(error);
    });
    child.once("error", (error) => this.fail(error));
    return child;
  }

  private request<T>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 30 * 60_000): Promise<T> {
    const child = this.ensureWorker();
    const id = randomUUID();
    return new Promise<T>((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Speech engine timed out while running ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolveRequest(value as T), reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async loadModel(settings: AppSettings, fromSetup = false): Promise<void> {
    if (!settings.modelLicenseAccepted) throw new Error("Accept the Nyra model-weight license before loading a model");
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      if (!fromSetup && !(await this.isEnvironmentReady())) throw new Error("Local engine setup is required before loading a model");
      const model = modelById(settings.model);
      this.updateStatus({ phase: "loading", engine: "loading", message: `Loading ${model.name}`, model: settings.model, progress: 0.85 });
      const runtime = await this.request<{ backend: "ct2" | "transformers" }>("load", {
        model: model.shorthand,
        backend: settings.backend,
        computeType: settings.computeType,
        speculativeDecoding: settings.speculativeDecoding,
        cacheDir: this.storage.modelCacheDirectory,
      });
      this.updateStatus({ phase: "idle", engine: "ready", message: `${model.name} ready`, model: settings.model, backend: runtime.backend, progress: 1 });
    })().catch((error) => {
      this.fail(error);
      throw error;
    }).finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }

  async ensureLoaded(settings: AppSettings): Promise<void> {
    if (this.status.engine === "ready" && this.status.model === settings.model) return;
    await this.loadModel(settings);
  }

  async transcribe(payload: Record<string, unknown>, settings: AppSettings): Promise<Record<string, unknown>> {
    await this.ensureLoaded(settings);
    return this.request<Record<string, unknown>>("transcribe", {
      ...payload,
      language: settings.language,
      mode: payload.mode ?? settings.transcriptionMode,
      wordTimestamps: settings.wordTimestamps,
      speculativeDecoding: settings.speculativeDecoding,
      customWords: settings.customWords,
    });
  }

  async runTool(command: "verbatimize" | "forcedAlign", payload: Record<string, unknown>, settings: AppSettings): Promise<Record<string, unknown>> {
    await this.ensureLoaded(settings);
    return this.request<Record<string, unknown>>(command, {
      ...payload,
      language: settings.language,
      wordTimestamps: settings.wordTimestamps,
      customWords: settings.customWords,
    });
  }

  async unload(): Promise<void> {
    if (this.worker) {
      try { await this.request("unload", {}, 60_000); } catch { /* worker may already be gone */ }
    }
    this.updateStatus({ phase: "idle", engine: existsSync(this.venvPython()) ? "unloaded" : "missing", message: "Model unloaded", model: null, backend: null, progress: null });
  }

  async reset(): Promise<void> {
    await this.shutdown();
    if (existsSync(this.storage.venvDirectory)) rmSync(this.storage.venvDirectory, { recursive: true, force: true });
    this.updateStatus({ phase: "idle", engine: "missing", message: "Local Python environment removed", model: null, backend: null, progress: null });
  }

  async shutdown(): Promise<void> {
    const child = this.worker;
    if (!child) return;
    try { await this.request("shutdown", {}, 10_000); } catch { /* force close below */ }
    child.kill();
    this.worker = null;
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try { writeFileSync(join(this.storage.dataDirectory, "last-asr-error.log"), `${this.stderr}\n${message}\n`, "utf8"); } catch { /* diagnostics are best-effort */ }
    this.updateStatus({ phase: "error", engine: "error", message: conciseError(message), detail: message, progress: null });
  }
}
