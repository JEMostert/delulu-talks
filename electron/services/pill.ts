import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";

export type PillState = "hidden" | "listening" | "transcribing" | "magic" | "delivering" | "success" | "error";

export type PillCommand = {
  state: PillState;
  title?: string;
  detail?: string;
  level?: number;
};

export type PillIo = {
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  existsSync?: typeof existsSync;
  now?: () => number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  scriptPath?: () => string;
};

const LAYER_SHELL_CANDIDATES = [
  "/usr/lib/libgtk4-layer-shell.so",
  "/usr/lib64/libgtk4-layer-shell.so",
  "/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so.0",
];

export function resolveSystemPython(env: NodeJS.ProcessEnv, run: typeof spawnSync, exists: typeof existsSync): string {
  const which = run(process.platform === "win32" ? "where" : "which", ["python3"], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  const located = which.status === 0 ? which.stdout.trim().split(/\r?\n/)[0] : "";
  if (located && exists(located)) return located;
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (exists(candidate)) return candidate;
  }
  return "python3";
}

export function layerShellCandidates(pkgConfigDirectory: string): string[] {
  return [
    pkgConfigDirectory && join(pkgConfigDirectory, "libgtk4-layer-shell.so"),
    ...LAYER_SHELL_CANDIDATES,
  ].filter(Boolean);
}

export class PillService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private desired: PillCommand = { state: "hidden" };
  private unavailableReason: string | null = null;
  private retryAfter = 0;
  private resolvedLibrary: string | null | undefined;
  private resolvedPython: string | undefined;
  private usePreload = false;
  private preloadAttempted = false;
  private readonly spawn: typeof spawn;
  private readonly spawnSync: typeof spawnSync;
  private readonly existsSync: typeof existsSync;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly io: PillIo = {}) {
    this.spawn = io.spawn ?? spawn;
    this.spawnSync = io.spawnSync ?? spawnSync;
    this.existsSync = io.existsSync ?? existsSync;
    this.now = io.now ?? Date.now;
    this.platform = io.platform ?? process.platform;
    this.env = io.env ?? process.env;
  }

  get method(): "layer-shell" | "unavailable" {
    return this.supportedEnvironment() && this.layerShellLibrary() && !this.unavailableReason ? "layer-shell" : "unavailable";
  }

  get detail(): string {
    if (!this.supportedEnvironment()) return "Native pill requires a Wayland layer-shell compositor";
    if (!this.layerShellLibrary()) return "Install gtk4-layer-shell to enable the native pill";
    return this.unavailableReason ?? "Native click-through layer-shell pill";
  }

  prepare(): void {
    if (!this.supportedEnvironment() || this.child) return;
    this.desired = { state: "hidden" };
    this.start();
  }

  show(command: { state: Exclude<PillState, "hidden">; title?: string; detail?: string; level?: number }): void {
    this.send(command);
  }

  hide(): void {
    this.send({ state: "hidden" });
  }

  level(value: number): void {
    if (this.desired.state !== "listening") return;
    const level = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.send({ ...this.desired, state: "listening", level });
  }

  private send(command: PillCommand): void {
    this.desired = command.state === "listening" ? command : { state: command.state, title: command.title, detail: command.detail };
    if (!this.supportedEnvironment()) return;
    if (!this.child) this.start();
    if (this.ready) this.write(command);
  }

  private supportedEnvironment(): boolean {
    return this.platform === "linux" && this.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
  }

  private scriptPath(): string {
    if (this.io.scriptPath) return this.io.scriptPath();
    return app.isPackaged
      ? join(process.resourcesPath, "overlay", "pill.py")
      : resolve(app.getAppPath(), "electron", "overlay", "pill.py");
  }

  private pythonPath(): string {
    this.resolvedPython ??= resolveSystemPython(this.env, this.spawnSync, this.existsSync);
    return this.resolvedPython;
  }

  private start(): void {
    if (this.now() < this.retryAfter) return;
    const script = this.scriptPath();
    if (!this.existsSync(script)) {
      this.unavailableReason = "Native pill helper is missing";
      return;
    }
    this.ready = false;
    this.unavailableReason = null;
    const layerShellLib = this.layerShellLibrary();
    if (!layerShellLib) {
      this.unavailableReason = "Install gtk4-layer-shell to enable the native pill";
      return;
    }
    const childEnv: NodeJS.ProcessEnv = { ...this.env, GDK_BACKEND: "wayland", PYTHONUNBUFFERED: "1" };
    if (this.usePreload) {
      // Some hosts need the Wayland shim on the linker path before GTK is imported.
      childEnv.LD_PRELOAD = this.env.LD_PRELOAD ? `${layerShellLib}:${this.env.LD_PRELOAD}` : layerShellLib;
    }
    const child = this.spawn(this.pythonPath(), [script], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { type?: string; message?: string };
          if (message.type === "ready") {
            this.ready = true;
            this.unavailableReason = null;
            this.write(this.desired);
          } else if (message.type === "error") {
            this.unavailableReason = message.message ?? "Native pill could not start";
          }
        } catch { /* Ignore helper diagnostics that are not protocol messages. */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000); });
    let finished = false;
    const finish = (code: number | null, error?: Error) => {
      if (finished || this.child !== child) return;
      finished = true;
      if (error) this.unavailableReason = `Native pill unavailable: ${error.message}`;
      const started = this.ready;
      this.child = null;
      this.ready = false;
      const failed = !started || Boolean(code && code !== 0) || Boolean(this.unavailableReason);
      if (failed && !this.preloadAttempted && layerShellLib) {
        this.preloadAttempted = true;
        this.usePreload = true;
        this.retryAfter = 0;
        this.start();
        return;
      }
      this.retryAfter = this.now() + 10_000;
      if (!started || (code && code !== 0)) {
        this.unavailableReason = (stderr.trim().split(/\r?\n/).at(-1) || this.unavailableReason || `Native pill exited with code ${code ?? 0}`).slice(0, 240);
      }
    };
    child.once("error", (error) => {
      finish(null, error);
    });
    child.once("exit", (code) => {
      finish(code);
    });
  }

  private layerShellLibrary(): string | null {
    if (this.resolvedLibrary !== undefined) return this.resolvedLibrary;
    const result = this.spawnSync("pkg-config", ["--variable=libdir", "gtk4-layer-shell-0"], { encoding: "utf8", windowsHide: true });
    const directory = result.status === 0 ? result.stdout.trim() : "";
    this.resolvedLibrary = layerShellCandidates(directory).find((candidate) => this.existsSync(candidate)) ?? null;
    return this.resolvedLibrary;
  }

  private write(command: PillCommand): void {
    if (!this.child || !this.ready || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  shutdown(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) return;
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 600);
    timeout.unref();
    child.once("exit", () => clearTimeout(timeout));
  }
}
