import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { activateRuntime, runtimePython, rollbackRuntime } from "./location";
import type { AppSettings } from "../../src/types";
import {
  INSTALLER_PACKAGES,
  MAGIC_PACKAGES,
  RUNTIME_REVISION,
  SPEECH_PACKAGES,
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

/** Owns interpreter discovery and package installation; model loading is separate. */
export class RuntimeInstaller {
  private processes = new Set<ReturnType<typeof spawn>>();
  private cancelled = false;
  private validatedPython: string | null = null;
  constructor(
    private readonly paths: Paths,
    private readonly constraintsPath: string | null,
    private readonly environment: () => NodeJS.ProcessEnv,
  ) {}
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
      await this.run(this.python, ["-c", READINESS[kind]], undefined, 15_000);
      this.validatedPython = `${kind}:${this.python}`;
      return true;
    } catch {
      return false;
    }
  }

  private async basePython(command: string): Promise<string[]> {
    const configured = (
      command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
    ).map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
    const fallbacks =
      process.platform === "win32"
        ? [["py", "-3.12"], ["py", "-3.11"], ["python3.12"], ["python3.11"]]
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
            "import sys; print('.'.join(map(str, sys.version_info[:2])))",
          ],
          undefined,
          5000,
        );
        const [major, minor] = version.split(".").map(Number);
        if (major === 3 && minor >= 11 && minor <= 13) return candidate;
      } catch {
        /* Try the next supported interpreter. */
      }
    }
    throw new Error(
      "Install Python 3.11–3.13, then try again. You can set its full path in Settings → Advanced.",
    );
  }

  async install(
    kind: "speech" | "magic",
    settings: AppSettings,
    publish: (progress: InstallProgress) => void,
  ): Promise<void> {
    this.cancelled = false;
    this.validatedPython = null;
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
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    // Never modify the active environment. Interrupted candidates are ignored,
    // and the previous generation stays on disk for recovery.
    {
      const python = await this.basePython(settings.pythonCommand);
      await stage(
        python[0],
        [...python.slice(1), "-m", "venv", candidate],
        "Creating your local runtime",
        0.12,
      );
    }
    await stage(
      candidatePython,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        ...INSTALLER_PACKAGES,
      ],
      "Preparing the package installer",
      0.22,
    );
    const constraints =
      this.constraintsPath &&
      process.platform === "linux" &&
      process.arch === "x64"
        ? ["--constraint", this.constraintsPath]
        : [];
    await stage(
      candidatePython,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        ...constraints,
        ...(kind === "speech" ? SPEECH_PACKAGES : MAGIC_PACKAGES),
      ],
      kind === "speech"
        ? "Installing the speech runtime"
        : "Installing the Magic runtime",
      0.45,
    );
    await stage(
      candidatePython,
      ["-m", "pip", "check"],
      "Checking package compatibility",
      0.72,
    );
    await stage(
      candidatePython,
      ["-c", READINESS[kind]],
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
