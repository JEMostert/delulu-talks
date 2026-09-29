import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, release } from "node:os";
import { usesMetal } from "./platform";
import { activateRuntime, runtimePython, rollbackRuntime } from "./location";
import type { AppSettings } from "../../src/types";
import { resolveRuntimeArtifacts } from "./artifacts";
import {
  createRuntimeInventory,
  inventoryBackend,
  PYTHON_INVENTORY_PROBE,
  writeRuntimeInventory,
  type RequestedInstallStage,
  type TargetPlatform,
} from "./inventory";
import {
  INSTALLER_PACKAGES,
  MAGIC_PACKAGES,
  RUNTIME_REVISION,
  SPEECH_PACKAGES,
  METAL_PACKAGES,
  WINDOWS_CUDA_PACKAGES,
  WINDOWS_SPEECH_PACKAGES,
} from "./manifest";

export type InstallProgress = {
  message: string;
  progress: number;
  detail?: string;
};
type Paths = { dataDirectory: string; venvDirectory: string };
const READINESS = {
  speech: "from qwen_asr import Qwen3ASRModel",
  magic:
    "import torch, torchvision, transformers; from transformers import AutoModelForMultimodalLM, AutoProcessor; assert int(transformers.__version__.split('.')[0]) >= 5",
};
const METAL_READINESS =
  "import sys, platform; assert sys.version_info[:2] == (3,12) and platform.machine() == 'arm64'; import mlx.core as mx; from mlx_audio.stt.utils import load_model, load_audio; assert mx.metal.is_available()";
const WINDOWS_READINESS =
  "import sys; assert sys.version_info[:2] == (3,12); import torch, soundfile, soxr; from transformers import Qwen3ASRConfig, Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor, Qwen3ASRFeatureExtractor; assert torch.version.cuda is not None and torch.cuda.is_available(), 'R2T2 requires a working NVIDIA CUDA GPU and driver'";

/** Owns interpreter discovery and package installation; model loading is separate. */
export class RuntimeInstaller {
  private processes = new Set<ReturnType<typeof spawn>>();
  private cancelled = false;
  private validatedPython: string | null = null;
  constructor(
    private readonly paths: Paths,
    private readonly constraintsPath: string | null,
    private readonly environment: () => NodeJS.ProcessEnv,
    private readonly metal = usesMetal(),
    private readonly windows = process.platform === "win32",
    private readonly target: TargetPlatform = {
      platform: process.platform,
      arch: process.arch,
    },
  ) {}
  private readiness(kind: "speech" | "magic"): string {
    return kind === "speech"
      ? this.metal
        ? METAL_READINESS
        : this.windows
          ? WINDOWS_READINESS
          : READINESS.speech
      : READINESS.magic;
  }
  get python(): string {
    return runtimePython(this.paths.venvDirectory);
  }
  rollback(): void {
    this.validatedPython = null;
    rollbackRuntime(this.paths.venvDirectory);
  }

  private run(
    program: string,
    args: string[],
    onOutput?: (output: string) => void,
    timeoutMs = 30 * 60_000,
  ): Promise<string> {
    if (this.cancelled)
      return Promise.reject(
        new Error(
          "Runtime setup cancelled. The previous environment is unchanged.",
        ),
      );
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        windowsHide: true,
        env: this.environment(),
      });
      this.processes.add(child);
      let output = "";
      let diagnostic = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            "Runtime operation timed out. Check your connection and try Repair.",
          ),
        );
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-256_000);
        onOutput?.(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        diagnostic = `${diagnostic}${chunk}`.slice(-16_000);
        onOutput?.(String(chunk));
      });
      const finish = () => {
        clearTimeout(timer);
        this.processes.delete(child);
      };
      child.once("error", (error) => {
        finish();
        reject(error);
      });
      child.once("close", (code) => {
        finish();
        if (code === 0) resolve(output.trim());
        else
          reject(
            new Error(diagnostic.trim() || `Runtime command failed (${code})`),
          );
      });
    });
  }
  stop(): void {
    this.cancelled = true;
    for (const child of this.processes) child.kill();
    this.processes.clear();
  }

  async ready(kind: "speech" | "magic"): Promise<boolean> {
    try {
      if (!existsSync(this.python)) return false;
      if (this.validatedPython === `${kind}:${this.python}`) return true;
      await this.run(
        this.python,
        ["-c", this.readiness(kind)],
        undefined,
        60_000,
      );
      this.validatedPython = `${kind}:${this.python}`;
      return true;
    } catch {
      return false;
    }
  }

  private async basePython(command: string, metal: boolean): Promise<string[]> {
    const configured = (
      command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
    ).map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
    const fallbacks = metal
      ? [
          ["python3.12"],
          ["/opt/homebrew/bin/python3.12"],
          [join(homedir(), ".local/bin/python3.12")],
        ]
      : this.windows
        ? [["py", "-3.12"], ["python3.12"]]
        : [["python3.13"], ["python3.12"], ["python3.11"]];
    const candidates = ["python", "python3"].includes(configured[0] ?? "")
      ? [...fallbacks, configured]
      : [configured];
    for (const candidate of candidates) {
      if (!candidate.length) continue;
      try {
        const version = await this.run(
          candidate[0],
          [
            ...candidate.slice(1),
            "-c",
            metal
              ? "import sys, platform; assert platform.machine() == 'arm64'; print('.'.join(map(str, sys.version_info[:2])))"
              : "import sys; print('.'.join(map(str, sys.version_info[:2])))",
          ],
          undefined,
          5000,
        );
        const [major, minor] = version.split(".").map(Number);
        if (
          major === 3 &&
          (metal || this.windows ? minor === 12 : minor >= 11 && minor <= 13)
        )
          return candidate;
      } catch {
        /* Try the next supported interpreter. */
      }
    }
    throw new Error(
      metal
        ? "Install native arm64 Python 3.12, then set its full path in Settings → Advanced. Rosetta Python is not supported."
        : this.windows
          ? "Install Python 3.12, then try again. You can set its full path in Settings → Advanced."
          : "Install Python 3.11–3.13, then try again. You can set its full path in Settings → Advanced.",
    );
  }

  async install(
    kind: "speech" | "magic",
    settings: AppSettings,
    publish: (progress: InstallProgress) => void,
  ): Promise<void> {
    this.cancelled = false;
    this.validatedPython = null;
    const metal = kind === "speech" && this.metal;
    if (
      metal &&
      process.platform === "darwin" &&
      Number(release().split(".")[0]) < 24
    )
      throw new Error("R2T2 MLX requires macOS 15 or later.");
    const stage = async (
      program: string,
      args: string[],
      message: string,
      progress: number,
    ) => {
      publish({ message, progress });
      return this.run(program, args, (output) => {
        const detail = output.trim().split(/\r?\n/).at(-1)?.slice(-350);
        if (detail) publish({ message, progress, detail });
      });
    };
    publish({ message: "Checking your Python environment", progress: 0.05 });
    mkdirSync(this.paths.dataDirectory, { recursive: true });
    const generation = randomUUID();
    const candidate = join(this.paths.venvDirectory, "generations", generation);
    mkdirSync(candidate, { recursive: true });
    const candidatePython = join(
      candidate,
      this.windows ? "Scripts/python.exe" : "bin/python",
    );
    // Never modify the active environment. Interrupted candidates are ignored,
    // and the previous generation stays on disk for recovery.
    {
      const python = await this.basePython(settings.pythonCommand, metal);
      await stage(
        python[0],
        [...python.slice(1), "-m", "venv", candidate],
        "Creating your local runtime",
        0.12,
      );
    }
    const requested: RequestedInstallStage[] = [];
    const installPackages = async (
      name: RequestedInstallStage["name"],
      requirements: string[],
      options: string[],
      message: string,
      progress: number,
      constraint: RequestedInstallStage["constraint"] = null,
    ) => {
      const reportPath = join(candidate, `runtime-${kind}-${name}-artifacts.json`);
      const requirementsPath = join(candidate, `runtime-${kind}-${name}-artifacts.txt`);
      const resolverArguments = [
        "install",
        "--disable-pip-version-check",
        "--dry-run",
        "--report", reportPath,
        ...options,
        ...requirements,
      ];
      await stage(
        candidatePython,
        ["-m", "pip", ...resolverArguments],
        `Resolving artifacts: ${message.toLowerCase()}`,
        progress,
      );
      const resolved = resolveRuntimeArtifacts(readFileSync(reportPath, "utf8"));
      writeFileSync(requirementsPath, resolved.requirements, { mode: 0o600 });
      const pipArguments = [
        "install", "--disable-pip-version-check", "--no-deps",
        // Retain stage policy for installation/build hooks as well as resolution
        // (indexes, constraints, and any future build-isolation/binary options).
        ...options,
        "--requirement", requirementsPath,
      ];
      requested.push({
        name,
        requirements: [...requirements],
        pipArguments,
        constraint,
        artifacts: resolved.artifacts,
        resolverArguments,
        artifactRequirements: resolved.requirements,
      });
      // An empty resolver report means the requested packages are already present.
      if (!resolved.artifacts.length) return;
      return stage(
        candidatePython,
        ["-m", "pip", ...pipArguments],
        message,
        progress,
      );
    };
    await installPackages(
      "installer",
      INSTALLER_PACKAGES,
      [],
      "Preparing the package installer",
      0.22,
    );
    const constraints =
      this.constraintsPath &&
      !this.windows &&
      this.target.platform === "linux" &&
      this.target.arch === "x64"
        ? ["--constraint", this.constraintsPath]
        : [];
    if (this.windows) {
      await installPackages(
        "windows-cuda",
        WINDOWS_CUDA_PACKAGES,
        ["--index-url", "https://download.pytorch.org/whl/cu130"],
        "Installing the native Windows CUDA runtime",
        0.32,
      );
    }
    await installPackages(
      "runtime",
      kind === "speech"
        ? metal
          ? METAL_PACKAGES
          : this.windows
            ? WINDOWS_SPEECH_PACKAGES
            : SPEECH_PACKAGES
        : MAGIC_PACKAGES,
      constraints,
      kind === "speech"
        ? "Installing the speech runtime"
        : "Installing the Magic runtime",
      0.45,
      constraints.length
        ? {
            path: this.constraintsPath!,
            contents: readFileSync(this.constraintsPath!, "utf8"),
          }
        : null,
    );
    await stage(
      candidatePython,
      ["-m", "pip", "check"],
      "Checking package compatibility",
      0.72,
    );
    await stage(
      candidatePython,
      ["-c", this.readiness(kind)],
      "Validating the new runtime before switching",
      0.76,
    );
    const versions = await this.run(
      candidatePython,
      ["-m", "pip", "freeze"],
      undefined,
      15_000,
    );
    writeFileSync(
      join(candidate, `runtime-${kind}-installed.txt`),
      `# Delulu runtime ${RUNTIME_REVISION}\n${versions}\n`,
      { mode: 0o600 },
    );
    publish({
      message: "Recording the runtime dependency inventory",
      progress: 0.78,
    });
    let observation: string;
    try {
      observation = await this.run(
        candidatePython,
        ["-B", "-c", PYTHON_INVENTORY_PROBE],
        undefined,
        15_000,
      );
    } catch (error) {
      throw new Error(
        `Could not inspect runtime dependencies: ${error instanceof Error ? error.message : String(error)}. The previous environment is unchanged.`,
      );
    }
    const inventory = createRuntimeInventory(
      {
        revision: RUNTIME_REVISION,
        kind,
        generation,
        backend: inventoryBackend(kind, metal, this.windows),
        target: this.target,
        python: candidatePython,
        directory: candidate,
        requested,
      },
      observation,
    );
    writeRuntimeInventory(candidate, inventory);
    if (this.cancelled)
      throw new Error(
        "Runtime setup cancelled. The previous environment is unchanged.",
      );
    activateRuntime(this.paths.venvDirectory, generation);
    publish({
      message: "Runtime installed. Preparing your model…",
      progress: 0.8,
    });
  }
}
