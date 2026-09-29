import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { WorkerClient, transcriptionTimeout } from "./workerClient";

const execute = promisify(execFile);
const R2T2 = "netease-youdao/Confucius4-R2T2";
const R2T2_MLX = "mlx-community/Confucius4-R2T2-bf16";
type WorkerStatus = { loaded: boolean; model: string | null; device: string | null; python?: string };
export type NativeSpeechResult = { text: string; language?: string; duration: number; processingTime: number; inferenceTime?: number };
export type NativeHarnessOptions = { python: string; workerScript: string; cacheDirectory: string; loadTimeoutMs?: number };
export type PreparedNativeAudio = { path: string; durationMs: number; sourceSha256: string; audioSha256: string; cleanup: () => Promise<void> };

export async function nativeFileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

/** Shared opt-in adapter driver; importing it neither starts a worker nor loads weights. */
export class NativeInferenceHarness {
  private readonly worker: WorkerClient;
  private readonly env: NodeJS.ProcessEnv;
  private closed = false;
  private probed = false;
  private loaded: WorkerStatus | null = null;
  constructor(private readonly options: NativeHarnessOptions) {
    if (!existsSync(options.python) || !existsSync(options.workerScript) || !existsSync(options.cacheDirectory))
      throw new Error("Native inference requires existing interpreter, worker script and pre-downloaded cache paths");
    if (!((process.platform === "darwin" && process.arch === "arm64") ||
      ((process.platform === "linux" || process.platform === "win32") && process.arch === "x64")))
      throw new Error("This harness supports native Apple Silicon MLX or Linux/Windows x64 CUDA only");
    this.env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1", HF_HOME: resolve(options.cacheDirectory),
      HF_HUB_CACHE: join(resolve(options.cacheDirectory), "hub"),
      HUGGINGFACE_HUB_CACHE: join(resolve(options.cacheDirectory), "hub") };
    this.worker = new WorkerClient(() => ({ python: options.python, script: options.workerScript, env: this.env }), () => {});
  }

  async probe(): Promise<Record<string, unknown>> {
    this.assertOpen();
    const script = `import importlib.metadata,json,platform,sys
packages={}
for name in ("mlx","mlx-audio","torch","transformers","vllm","qwen-asr"):
 try: packages[name]=importlib.metadata.version(name)
 except importlib.metadata.PackageNotFoundError: pass
result={"python":sys.version,"pythonVersion":list(sys.version_info[:3]),"platform":sys.platform,"architecture":platform.machine(),"os":platform.platform(),"packageVersions":packages}
if sys.platform != "darwin":
 import torch
 result["cudaAvailable"]=torch.cuda.is_available()
 result["cudaVersion"]=torch.version.cuda
 result["devices"]=[{"name":torch.cuda.get_device_name(i),"memoryBytes":torch.cuda.get_device_properties(i).total_memory} for i in range(torch.cuda.device_count())]
print(json.dumps(result))`;
    const { stdout } = await execute(this.options.python, ["-c", script], { env: this.env, timeout: 30_000, maxBuffer: 64_000, windowsHide: true });
    const metadata = JSON.parse(stdout) as Record<string, unknown>;
    const architecture = String(metadata.architecture).toLowerCase();
    if (process.platform === "darwin" && architecture !== "arm64")
      throw new Error("Native MLX validation requires arm64 Python; Rosetta is unsupported");
    if (process.platform !== "darwin" && !["amd64", "x86_64"].includes(architecture))
      throw new Error("Native CUDA validation requires x64 Python");
    if (metadata.platform !== process.platform)
      throw new Error("Runtime interpreter platform does not match this native harness");
    if (process.platform !== "darwin" && metadata.cudaAvailable !== true)
      throw new Error("The selected runtime has no available CUDA device; inference was not attempted");
    this.probed = true;
    return metadata;
  }

  async load(): Promise<{ status: WorkerStatus; wallSeconds: number }> {
    this.assertOpen();
    if (!this.probed) await this.probe();
    const started = performance.now();
    await this.worker.request("load", { cacheDir: resolve(this.options.cacheDirectory) }, this.options.loadTimeoutMs ?? 30 * 60_000);
    const status = await this.worker.request<WorkerStatus>("status");
    const expectedModel = process.platform === "darwin" ? R2T2_MLX : R2T2;
    const expectedDevice = process.platform === "darwin" ? "mlx" : "cuda";
    if (!status.loaded || status.model !== expectedModel || status.device !== expectedDevice)
      throw new Error("Native worker did not report the expected loaded R2T2 adapter/device");
    this.loaded = status;
    return { status, wallSeconds: (performance.now() - started) / 1000 };
  }

  async transcribe(audio: PreparedNativeAudio, language = "en"): Promise<{ result: NativeSpeechResult; wallSeconds: number }> {
    this.assertOpen();
    if (!this.loaded) throw new Error("Load and identify the R2T2 adapter before native transcription");
    const started = performance.now();
    const result = await this.worker.request<NativeSpeechResult>("transcribe", {
      audioPath: audio.path, language, durationMs: audio.durationMs,
    }, transcriptionTimeout(audio.durationMs));
    if (!result || typeof result.text !== "string" || !Number.isFinite(result.processingTime))
      throw new Error("Native worker returned an invalid speech result");
    return { result, wallSeconds: (performance.now() - started) / 1000 };
  }

  async unload(): Promise<WorkerStatus> {
    this.assertOpen();
    await this.worker.request("unload");
    this.loaded = null;
    const status = await this.worker.request<WorkerStatus>("status");
    if (status.loaded) throw new Error("Worker still reports a loaded speech model after unload");
    return status;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { if (this.worker.running) await this.worker.request("shutdown", {}, 5_000); }
    finally { this.loaded = null; await this.worker.stopAndWait(); }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Native inference harness is closed");
  }
}

async function wavDuration(path: string): Promise<number> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    await file.read(header, 0, 12, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE")
      throw new Error("Converted native fixture is not a RIFF/WAVE file");
    const size = (await file.stat()).size;
    let position = 12, byteRate = 0, audioBytes = 0;
    while (position + 8 <= size) {
      const chunk = Buffer.alloc(8);
      await file.read(chunk, 0, 8, position);
      const name = chunk.toString("ascii", 0, 4), length = chunk.readUInt32LE(4);
      if (position + 8 + length > size) throw new Error("Converted WAV contains a truncated chunk");
      if (name === "fmt ") {
        if (length < 16) throw new Error("Converted WAV format is incomplete");
        const format = Buffer.alloc(16);
        await file.read(format, 0, 16, position + 8);
        if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 ||
            format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16)
          throw new Error("Native fixture conversion must produce mono 16 kHz PCM16 audio");
        byteRate = format.readUInt32LE(8);
        if (byteRate !== 32000) throw new Error("Converted PCM16 byte rate is inconsistent");
      } else if (name === "data") audioBytes += length;
      position += 8 + length + (length % 2);
    }
    if (!byteRate || !audioBytes) throw new Error("Converted WAV contains no audio");
    return Math.round(audioBytes / byteRate * 1000);
  } finally { await file.close(); }
}

/** Conversion touches only this temporary directory; source audio is never overwritten. */
export async function prepareNativeAudio(source: string, filters: string[] = []): Promise<PreparedNativeAudio> {
  const sourcePath = resolve(source);
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.size > 512 * 1024 * 1024)
    throw new Error("Native fixture must be a regular audio file no larger than 512 MiB");
  const directory = await mkdtemp(join(tmpdir(), "delulu-native-"));
  const path = join(directory, "sample.wav");
  try {
    await execute("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-protocol_whitelist", "file,pipe", "-i", sourcePath,
      ...filters, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-t", "3601", path],
      { timeout: 120_000, maxBuffer: 80_000, windowsHide: true });
    const durationMs = await wavDuration(path);
    if (durationMs > 60 * 60_000) throw new Error("Native fixture exceeds the one-hour harness limit");
    return { path, durationMs, sourceSha256: await nativeFileHash(sourcePath), audioSha256: await nativeFileHash(path),
      cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) };
  } catch (error) {
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Native fixture preparation and cleanup failed", { cause: error }); }
    throw error;
  }
}

export async function nativeWorkerSources(workerScript: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const name of ["transcription_engine.py", "speech_engine.py", "metal_speech.py", "windows_speech.py", "windows_checkpoint.py"]) {
    const path = name === "transcription_engine.py" ? workerScript : join(dirname(workerScript), name);
    if (existsSync(path)) hashes[name] = await nativeFileHash(path);
  }
  return hashes;
}
