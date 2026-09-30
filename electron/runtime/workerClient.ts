import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { backendFailure } from "./privateDiagnostics";
import {
  BoundedWorkerLines,
  WorkerDiagnosticTail,
  serializeWorkerRequest,
  workerProtocolLimits,
  validateWorkerResponse,
  validateWorkerResult,
  validateWorkerProgress,
  type WorkerProgress,
  type WorkerProtocolLimits,
} from "./workerProtocol";

type Pending = {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
const PREFIX = "@delulu:";

export function operationTimeout(command: string): number {
  if (command === "load" || command === "magicLoad") return 30 * 60_000;
  if (command === "transcribe") return 120_000;
  if (command === "magicRewrite") return 180_000;
  return 30_000;
}

export function transcriptionTimeout(durationMs: unknown): number {
  return typeof durationMs === "number" && Number.isFinite(durationMs)
    ? Math.min(15 * 60_000, Math.max(120_000, durationMs * 3))
    : 15 * 60_000;
}

/** One JSON-lines transport, with bounded diagnostics and deterministic failure cleanup. */
export class WorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private readonly limits: WorkerProtocolLimits;
  private diagnostics: WorkerDiagnosticTail;
  constructor(
    private readonly config: () => {
      python: string;
      script: string;
      env: NodeJS.ProcessEnv;
    },
    private readonly onFailure: (error: Error) => void,
    private readonly onProgress?: (detail: string, event?: WorkerProgress) => void,
    limits: Partial<WorkerProtocolLimits> = {},
  ) {
    this.limits = workerProtocolLimits(limits);
    this.diagnostics = new WorkerDiagnosticTail(this.limits.stderrBytes);
  }
  get running(): boolean {
    return this.child !== null;
  }
  get stderr(): string {
    return this.diagnostics.text;
  }
  get busy(): boolean {
    return this.pending.size > 0;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const { python, script, env } = this.config();
    const child = spawn(python, ["-u", script], {
      windowsHide: true,
      env,
      // vLLM starts GPU-owning subprocesses. Give each runtime its own group
      // so stopping it also releases those descendants on Linux/macOS.
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.diagnostics = new WorkerDiagnosticTail(this.limits.stderrBytes);
    const lines = new BoundedWorkerLines(this.limits.stdoutLineBytes);
    const receive = (line: string): boolean => {
      // stop() can leave buffered lines until this process exits. They belong
      // to its generation, even if a failure callback has already retried.
      if (this.child !== child) return false;
      if (line.startsWith("@delulu-progress:")) {
        const event = validateWorkerProgress(JSON.parse(line.slice("@delulu-progress:".length)));
        const request = this.pending.get(event.id);
        if (request && request.command === event.command)
          this.onProgress?.(event.detail.slice(-350), event);
        return this.child === child;
      }
      if (!line.startsWith(PREFIX)) return true;
      try {
        const response = validateWorkerResponse(JSON.parse(line.slice(PREFIX.length)));
        const request = this.pending.get(response.id);
        if (!request) return true;
        if (response.ok) validateWorkerResult(request.command, response.result);
        clearTimeout(request.timer);
        this.pending.delete(response.id);
        if (response.ok) request.resolve(response.result);
        else
          request.reject(
            new Error(
              backendFailure(response.error).message,
            ),
          );
      } catch (reason) {
        this.fail(new Error(backendFailure(reason).message));
      }
      return this.child === child;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try {
        lines.push(chunk, receive);
      } catch (reason) {
        if (this.child === child)
          this.fail(
            new Error(backendFailure(reason).message),
          );
      }
    });
    child.stdout.once("end", () => {
      if (this.child === child) lines.end(receive);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.diagnostics.push(chunk);
    });
    child.once("error", (error) => {
      if (this.child === child) this.fail(new Error(backendFailure(error).message));
    });
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.fail(
        new Error(
          code === 0
            ? "Model worker closed"
            : `${backendFailure(this.stderr).message} (worker exit ${code ?? "signal"})`,
        ),
      );
    });
    return child;
  }

  request<T>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = operationTimeout(command),
  ): Promise<T> {
    const id = randomUUID();
    let wire: string;
    let child: ChildProcessWithoutNullStreams;
    try {
      wire = serializeWorkerRequest(
        id,
        command,
        payload,
        this.limits.requestBytes,
      );
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Model worker timeout must be a positive number");
      if (this.pending.size >= this.limits.pendingRequests)
        throw new Error(
          `Model worker already has ${this.limits.pendingRequests} pending requests. Wait for an operation to finish and try again.`,
        );
      child = this.start();
    } catch (reason) {
      return Promise.reject(reason);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(
              `Model operation ${command} timed out. Load the model to try again.`,
            ),
          ),
        timeoutMs,
      );
      this.pending.set(id, {
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(wire, (error) => {
        if (error && this.child === child) this.fail(error);
      });
    });
  }

  private fail(error: Error): void {
    this.stop(error);
    this.onFailure(error);
  }
  async stopAndWait(error = new Error("Model worker stopped")): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    const pid = child.pid;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    this.stop(error);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
    if (process.platform !== "win32") {
      // Descendants may outlive their parent while releasing CUDA resources.
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(-pid, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }
  stop(error = new Error("Model worker stopped")): void {
    const child = this.child;
    this.child = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );
      killer.once("error", () => child.kill());
    } else {
      const pid = child.pid;
      try {
        process.kill(-pid, "SIGTERM");
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== "ESRCH") child.kill();
      }
      // Reject active requests immediately, then give this generation five seconds
      // to release resources. stop() is also used by timeout/failure paths that
      // never call stopAndWait(); their GPU descendants must not survive forever.
      // Keep the timer even if the parent exits: children can outlive it. Capture
      // the old group rather than this.child, which may already be a new worker.
      const escalation = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch (reason) {
          if ((reason as NodeJS.ErrnoException).code !== "ESRCH")
            child.kill("SIGKILL");
        }
      }, 5000);
      escalation.unref();
    }
  }
}
