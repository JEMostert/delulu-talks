import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

type Pending = {
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
  private diagnostics = "";
  constructor(
    private readonly config: () => {
      python: string;
      script: string;
      env: NodeJS.ProcessEnv;
    },
    private readonly onFailure: (error: Error) => void,
  ) {}
  get running(): boolean {
    return this.child !== null;
  }
  get stderr(): string {
    return this.diagnostics;
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
    this.diagnostics = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.startsWith(PREFIX)) return;
      try {
        const response = JSON.parse(line.slice(PREFIX.length));
        if (typeof response.id !== "string" || typeof response.ok !== "boolean")
          throw new Error("Invalid model worker response");
        const request = this.pending.get(response.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(response.id);
        if (response.ok) request.resolve(response.result);
        else
          request.reject(
            new Error(
              typeof response.error === "string"
                ? response.error
                : "Model operation failed",
            ),
          );
      } catch (reason) {
        this.fail(reason instanceof Error ? reason : new Error(String(reason)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = `${this.diagnostics}${chunk}`.slice(-80_000);
    });
    child.once("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.once("exit", (code) => {
      lines.close();
      if (this.child !== child) return;
      this.fail(
        new Error(
          code === 0
            ? "Model worker closed"
            : this.diagnostics.trim().split("\n").at(-1) ||
                `Model worker exited (${code})`,
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
    const child = this.start();
    const id = randomUUID();
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
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(
        `${JSON.stringify({ ...payload, id, command })}\n`,
        (error) => {
          if (error && this.child === child) this.fail(error);
        },
      );
    });
  }

  private fail(error: Error): void {
    this.stop(error);
    this.onFailure(error);
  }
  async stopAndWait(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    const pid = child.pid;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    this.stop();
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
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== "ESRCH") child.kill();
      }
    }
  }
}
