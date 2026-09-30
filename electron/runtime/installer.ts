import { SetupLog } from "./setupLog";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, release } from "node:os";
import { usesMetal } from "./platform";
import { activateRuntime, runtimeDirectory, runtimePython } from "./location";
import type { AppSettings, SetupStage } from "../../src/types";
import { resolveRuntimeArtifacts } from "./artifacts";
import {
  parseRuntimePrerequisiteError,
  PYTHON_INTERPRETER_PROBE,
  RuntimePrerequisiteCode,
  RuntimePrerequisiteError,
  runtimeReadinessScript,
  validatePythonInterpreter,
} from "./prerequisites";
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
  setupStage?: SetupStage;
  message: string;
  progress: number;
  detail?: string;
};
type Paths = { dataDirectory: string; venvDirectory: string; kind?: "speech" | "magic" };
/** Owns interpreter discovery and package installation; model loading is separate. */
export class RuntimeInstaller {
  readonly setupLog = new SetupLog();
  private setupStage = "Runtime preflight";
  private stageStarted: { attemptId: string; at: number } | null = null;

  recordSetupStage(message: string): void {
    const attemptId = this.setupLog.activeId;
    const now = performance.now();
    if (attemptId && this.stageStarted?.attemptId === attemptId)
      this.setupLog.record(attemptId, {
        type: "stage",
        stage: this.setupStage,
        message: "Stage ended",
        durationMs: Math.round(now - this.stageStarted.at),
      });
    this.setupStage = message;
    this.stageStarted = attemptId ? { attemptId, at: now } : null;
    this.setupLog.record(attemptId, {
      type: "stage",
      stage: message,
      message,
    });
  }

  recordSetupOutcome(message: string): void {
    const attemptId = this.setupLog.activeId;
    this.setupLog.record(attemptId, {
      type: "stage",
      stage: this.setupStage,
      message,
      ...(attemptId && this.stageStarted?.attemptId === attemptId
        ? { durationMs: Math.round(performance.now() - this.stageStarted.at) }
        : {}),
    });
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
  private processes = new Set<ReturnType<typeof spawn>>();
  private cancelled = false;
  private validatedPython: string | null = null;
  private candidate: { generation: string; python: string } | null = null;
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
    return runtimeReadinessScript(
      kind,
      this.target,
      kind === "speech" && this.metal,
    );
  }
  get python(): string {
    return this.candidate?.python ?? runtimePython(this.paths.venvDirectory);
  }
  private assertKind(kind: "speech" | "magic"): void {
    if (this.paths.kind && this.paths.kind !== kind)
      throw new Error(`This installer owns the ${this.paths.kind} runtime, not ${kind}`);
    const marker = join(runtimeDirectory(this.paths.venvDirectory), "runtime-role.json");
    // Preserve pre-marker generations and the legacy Writing environment.
    if (!existsSync(marker)) return;
    const role = JSON.parse(readFileSync(marker, "utf8"));
    if (role.kind !== kind)
      throw new Error(`The selected environment belongs to ${role.kind}, not ${kind}. Choose its dedicated runtime directory.`);
  }
  /** Call only after the candidate worker has completed real model warmup. */
  commit(): void {
    if (!this.candidate) throw new Error("No prepared runtime is available to activate");
    if (this.cancelled) throw new Error("Runtime setup cancelled before activation. Previous runtime remains selected.");
    this.recordSetupStage("Activating runtime after model load and warmup");
    activateRuntime(this.paths.venvDirectory, this.candidate.generation);
    this.candidate = null;
    this.recordSetupStage("Validated runtime activation committed");
  }

  rollback(): void {
    // Setup has not changed the durable pointer. Discard only this candidate;
    // do not roll back an unrelated already-active generation after a failure.
    this.recordSetupStage("Discarding candidate; previous runtime remains selected");
    this.candidate = null;
    this.validatedPython = null;
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
    const attemptId = this.setupLog.activeId;
    const stage = this.setupStage;
    const started = performance.now();
    this.setupLog.record(attemptId, {
      type: "command",
      stage,
      message: "Starting runtime command",
      command: { program, args: [...args] },
    });
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        windowsHide: true,
        env: this.environment(),
      });
      this.processes.add(child);
      let output = "";
      let diagnostic = "";
      const timer = setTimeout(() => {
        this.setupLog.record(attemptId, {
          type: "error",
          stage,
          message: "Runtime command timed out; termination requested",
          durationMs: Math.round(performance.now() - started),
        });
        child.kill();
        reject(
          new Error(
            "Runtime operation timed out. Check your connection and try Repair.",
          ),
        );
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-256_000);
        this.setupLog.record(attemptId, {
          type: "stdout", stage, message: String(chunk),
        });
        onOutput?.(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        diagnostic = `${diagnostic}${chunk}`.slice(-16_000);
        this.setupLog.record(attemptId, {
          type: "stderr", stage, message: String(chunk),
        });
        onOutput?.(String(chunk));
      });
      const finish = () => {
        clearTimeout(timer);
        this.processes.delete(child);
      };
      child.once("error", (error) => {
        this.setupLog.record(attemptId, {
          type: "error", stage, message: error.message,
          durationMs: Math.round(performance.now() - started),
        });
        finish();
        reject(error);
      });
      child.once("close", (code, signal) => {
        this.setupLog.record(attemptId, {
          type: "exit", stage, message: "Runtime command closed",
          durationMs: Math.round(performance.now() - started),
          exitCode: code, signal,
        });
        finish();
        if (this.cancelled)
          reject(
            new Error(
              "Runtime setup cancelled. The previous environment is unchanged.",
            ),
          );
        else if (code === 0) resolve(output.trim());
        else {
          const cause = new Error(
            diagnostic.trim() || `Runtime command failed (${code})`,
          );
          reject(parseRuntimePrerequisiteError(diagnostic, cause) ?? cause);
        }
      });
    });
  }
  stop(): void {
    this.setupLog.record(this.setupLog.activeId, {
      type: "stage", stage: this.setupStage,
      message: "Setup cancellation requested; terminating installer processes",
    });
    this.cancelled = true;
    for (const child of this.processes) child.kill();
    this.processes.clear();
  }

  async ready(kind: "speech" | "magic"): Promise<boolean> {
    try {
      this.assertKind(kind);
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
    } catch (error) {
      if (this.cancelled) throw error;
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
    const automatic =
      configured.length === 0 ||
      (configured.length === 1 &&
        ["python", "python3"].includes(configured[0]));
    const candidates = automatic
      ? [...fallbacks, configured]
      : [configured];
    const failures: RuntimePrerequisiteError[] = [];
    for (const candidate of candidates) {
      if (!candidate.length) continue;
      try {
        const probe = await this.run(
          candidate[0],
          [
            ...candidate.slice(1),
            "-c",
            PYTHON_INTERPRETER_PROBE,
          ],
          undefined,
          5000,
        );
        validatePythonInterpreter(probe, this.target, metal);
        return candidate;
      } catch (cause) {
        if (this.cancelled) throw cause;
        const failure = new RuntimePrerequisiteError(
          cause instanceof RuntimePrerequisiteError
            ? cause.code
            : RuntimePrerequisiteCode.PYTHON_VERSION,
          `${candidate.join(" ")}: ${cause instanceof RuntimePrerequisiteError ? cause.details : cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
        if (!automatic) throw failure;
        failures.push(failure);
      }
    }
    throw new RuntimePrerequisiteError(
      failures.at(-1)?.code ?? RuntimePrerequisiteCode.PYTHON_VERSION,
      `No supported interpreter was found. ${failures.map((failure) => `[${failure.code}] ${failure.details}`).join("; ")}`,
      { cause: new AggregateError(failures, "Automatic Python discovery failed") },
    );
  }

  async install(
    kind: "speech" | "magic",
    settings: AppSettings,
    publish: (progress: InstallProgress) => void,
  ): Promise<void> {
    if (this.paths.kind && this.paths.kind !== kind)
      throw new Error(`This installer owns the ${this.paths.kind} runtime, not ${kind}`);
    this.cancelled = false;
    this.candidate = null;
    this.validatedPython = null;
    this.validatedPython = null;
    const metal = kind === "speech" && this.metal;
    if (
      metal &&
      process.platform === "darwin" &&
      Number(release().split(".")[0]) < 24
    )
      throw new RuntimePrerequisiteError(
        RuntimePrerequisiteCode.METAL_UNAVAILABLE,
        `Found Darwin ${release()}; R2T2 MLX requires macOS 15 or later (Darwin 24+).`,
      );
    const stage = async (
      program: string,
      args: string[],
      message: string,
      progress: number,
      setupStage: SetupStage = "runtime-prepare",
    ) => {
      this.recordSetupStage(message);
        publish({ message, progress, setupStage });
      return this.run(program, args, (output) => {
        const detail = output.trim().split(/\r?\n/).at(-1)?.slice(-350);
        if (setupStage === "runtime-packages" || setupStage === "runtime-download" || setupStage === "runtime-install" || setupStage === "runtime-build") {
          for (const line of output.split(/\r?\n/).map((value) => value.trim())) {
            if (/^(Downloading|Using cached) /.test(line)) setupStage = "runtime-download";
            else if (/^Installing collected packages:/.test(line)) setupStage = "runtime-install";
            else if (/^(Building wheel|Building wheels|Preparing metadata)/.test(line)) setupStage = "runtime-build";
          }
        }
        if (detail) publish({ message, progress, detail, setupStage });
      });
    };
    this.recordSetupStage("Checking your Python environment");
    publish({ message: "Checking your Python environment", progress: 0.05, setupStage: "runtime-check" });
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
        "runtime-packages",
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
        : "Installing the rewrite runtime",
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
      "runtime-validate",
    );
    await stage(
      candidatePython,
      ["-c", this.readiness(kind)],
      "Validating the new runtime before switching",
      0.76,
      "runtime-validate",
    );
    this.recordSetupStage("Recording installed package versions");
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
    this.recordSetupStage("Recording the runtime dependency inventory");
    publish({
      message: "Recording the runtime dependency inventory",
      progress: 0.78,
      setupStage: "runtime-validate",
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
      if (this.cancelled) throw error;
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
    writeFileSync(
      join(candidate, "runtime-role.json"),
      JSON.stringify({ kind, revision: RUNTIME_REVISION }),
      { mode: 0o600 },
    );
    if (this.cancelled)
      throw new Error(
        "Runtime setup cancelled. The previous environment is unchanged.",
      );
    this.recordSetupStage("Candidate imports validated; awaiting model load and warmup");
    this.candidate = { generation, python: candidatePython };
    publish({
      message: "Runtime candidate prepared. Previous runtime stays selected until model warmup succeeds…",
      progress: 0.8,
      setupStage: "model-prepare",
    });
  }
}
