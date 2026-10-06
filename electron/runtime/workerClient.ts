import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { backendFailure } from "./privateDiagnostics";
import { DomainError, domainError } from "../../src/domainErrors";
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
  removeAbortListener?: () => void;
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
    private readonly onProgress?: (
      detail: string,
      event?: WorkerProgress,
    ) => void,
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
      // Give each runtime its own process group so stopping it also releases
      // any GPU-owning descendants on Linux/macOS.
      detached: process.platform !== "win32",
    });
    this.child = child;
    // A worker that exits mid-write raises EPIPE on stdin; the exit handler
    // reports the failure, so the stream error must not crash the app.
    child.stdin.on("error", () => undefined);
    this.diagnostics = new WorkerDiagnosticTail(this.limits.stderrBytes);
    const lines = new BoundedWorkerLines(this.limits.stdoutLineBytes);
    const receive = (line: string): boolean => {
      // stop() can leave buffered lines until this process exits. They belong
      // to its generation, even if a failure callback has already retried.
      if (this.child !== child) return false;
      if (line.startsWith("@delulu-progress:")) {
        const event = validateWorkerProgress(
          JSON.parse(line.slice("@delulu-progress:".length)),
        );
        const request = this.pending.get(event.id);
        if (request && request.command === event.command)
          this.onProgress?.(event.detail.slice(-350), event);
        return this.child === child;
      }
      if (!line.startsWith(PREFIX)) return true;
      try {
        const response = validateWorkerResponse(
          JSON.parse(line.slice(PREFIX.length)),
        );
        const request = this.pending.get(response.id);
        if (!request) return true;
        if (response.ok) validateWorkerResult(request.command, response.result);
        clearTimeout(request.timer);
        request.removeAbortListener?.();
        this.pending.delete(response.id);
        if (response.ok) request.resolve(response.result);
        else
          request.reject(
            new DomainError(
              "BACKEND_FAILURE",
              backendFailure(response.error).message,
              {
                operationId: response.id,
                operation: request.command,
                cause: new Error(backendFailure(response.error).message),
              },
            ),
          );
      } catch (reason) {
        this.fail(
          domainError(reason, {
            code: "WORKER_PROTOCOL",
            operationId: randomUUID(),
            operation: "worker:response",
            message:
              "Model worker returned an invalid response. Repair its runtime before retrying.",
          }),
        );
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
            domainError(reason, {
              code: "WORKER_PROTOCOL",
              operationId: randomUUID(),
              operation: "worker:stdout",
              message:
                "Model worker output exceeded its protocol limits. Repair its runtime before retrying.",
            }),
          );
      }
    });
    child.stdout.once("end", () => {
      if (this.child !== child) return;
      try {
        lines.end(receive);
      } catch (reason) {
        this.fail(
          domainError(reason, {
            code: "WORKER_PROTOCOL",
            operationId: randomUUID(),
            operation: "worker:stdout",
            message:
              "Model worker returned incomplete output. Repair its runtime before retrying.",
          }),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.diagnostics.push(chunk);
    });
    child.once("error", (error) => {
      if (this.child === child)
        this.fail(
          domainError(error, {
            code: "WORKER_UNAVAILABLE",
            operationId: randomUUID(),
            operation: "worker:start",
            message:
              "Could not start the model worker. Check Python and repair the runtime before retrying.",
          }),
        );
    });
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.fail(
        new DomainError(
          "WORKER_EXITED",
          code === 0
            ? "Model worker closed"
            : `Model worker exited (${code}). Load the model to try again.`,
          {
            operationId: randomUUID(),
            operation: "worker:exit",
            cause: new Error(backendFailure(this.stderr).message),
          },
        ),
      );
    });
    return child;
  }

  request<T>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = operationTimeout(command),
    signal?: AbortSignal,
  ): Promise<T> {
    const id = randomUUID();
    let wire: string;
    let child: ChildProcessWithoutNullStreams;
    try {
      if (signal?.aborted)
        throw new DomainError(
          "CANCELLED",
          "Model operation cancelled before it started",
          { operationId: id, operation: command },
        );
      wire = serializeWorkerRequest(
        id,
        command,
        payload,
        this.limits.requestBytes,
      );
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Model worker timeout must be a positive number");
      if (this.pending.size >= this.limits.pendingRequests)
        throw new DomainError(
          "BUSY",
          `Model worker already has ${this.limits.pendingRequests} pending requests. Wait for an operation to finish and try again.`,
          { operationId: id, operation: command },
        );
      try {
        child = this.start();
      } catch (reason) {
        throw domainError(reason, {
          code: "WORKER_UNAVAILABLE",
          operationId: id,
          operation: command,
          message:
            "Could not start the model worker. Check Python and repair the runtime before retrying.",
        });
      }
    } catch (reason) {
      return Promise.reject(
        domainError(reason, {
          code: "INVALID_REQUEST",
          operationId: id,
          operation: command,
        }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new DomainError(
              "TIMEOUT",
              `Model operation ${command} timed out. Load the model to try again.`,
              { operationId: id, operation: command },
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
      if (signal) {
        const cancel = () =>
          this.stop(
            new DomainError(
              "CANCELLED",
              "Model operation cancelled; its worker was stopped",
              {
                operationId: id,
                operation: command,
                cancellationEffect: "worker-stopped",
              },
            ),
          );
        signal.addEventListener("abort", cancel, { once: true });
        this.pending.get(id)!.removeAbortListener = () =>
          signal.removeEventListener("abort", cancel);
        // Cover cancellation between the preflight check and registration.
        if (signal.aborted) {
          cancel();
          return;
        }
      }
      child.stdin.write(wire, (error) => {
        if (error && this.child === child)
          this.fail(
            domainError(error, {
              code: "WORKER_EXITED",
              operationId: id,
              operation: command,
              message:
                "Could not send the model operation. Load the model to try again.",
            }),
          );
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
  stop(
    error: Error = new DomainError("CANCELLED", "Model worker stopped", {
      operationId: randomUUID(),
      operation: "worker:stop",
      cancellationEffect: "worker-stopped",
    }),
  ): void {
    const child = this.child;
    this.child = null;
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.removeAbortListener?.();
      const failure = domainError(error, {
        operationId: id,
        operation: request.command,
      });
      const interrupted =
        failure.operation !== "worker:stop" &&
        failure.operationId !== id &&
        ["TIMEOUT", "CANCELLED"].includes(failure.code);
      request.reject(
        new DomainError(
          interrupted ? "OPERATION_INTERRUPTED" : failure.code,
          interrupted
            ? "Model operation interrupted because another operation stopped its worker. Load the model before retrying."
            : failure.message,
          {
            operationId: id,
            operation: request.command,
            cause: failure.cause ?? failure,
            cancellationEffect:
              failure.code === "CANCELLED"
                ? "worker-stopped"
                : failure.cancellationEffect,
          },
        ),
      );
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
