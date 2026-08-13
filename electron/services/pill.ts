import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";

export type PillState = "hidden" | "listening" | "transcribing" | "magic" | "delivering" | "success" | "error";

type PillCommand = {
  state: PillState;
  title?: string;
  detail?: string;
};

export class PillService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private desired: PillCommand = { state: "hidden" };
  private unavailableReason: string | null = null;
  private retryAfter = 0;
  private resolvedLibrary: string | null | undefined;

  get method(): "layer-shell" | "unavailable" {
    return this.supportedEnvironment() && this.layerShellLibrary() && !this.unavailableReason ? "layer-shell" : "unavailable";
  }

  get detail(): string {
    if (!this.supportedEnvironment()) return "Native pill requires a Wayland layer-shell compositor";
    if (!this.layerShellLibrary()) return "Install gtk4-layer-shell to enable the native pill";
    return this.unavailableReason ?? "Native click-through layer-shell pill";
  }

  show(state: Exclude<PillState, "hidden">, detail?: string, title?: string): void {
    this.send({ state, detail, title });
  }

  hide(): void {
    this.send({ state: "hidden" });
  }

  private send(command: PillCommand): void {
    this.desired = command;
    if (!this.supportedEnvironment()) return;
    if (!this.child) this.start();
    if (this.ready) this.write(command);
  }

  private supportedEnvironment(): boolean {
    return process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
  }

  private scriptPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, "overlay", "pill.py")
      : resolve(app.getAppPath(), "electron", "overlay", "pill.py");
  }

  private start(): void {
    if (Date.now() < this.retryAfter) return;
    const script = this.scriptPath();
    if (!existsSync(script)) {
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
    const preload = process.env.LD_PRELOAD ? `${layerShellLib}:${process.env.LD_PRELOAD}` : layerShellLib;
    const child = spawn("/usr/bin/python3", [script], {
      // Python loads GTK before its introspection module, so the Wayland shim must be preloaded.
      env: { ...process.env, GDK_BACKEND: "wayland", LD_PRELOAD: preload, PYTHONUNBUFFERED: "1" },
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
            this.write(this.desired);
          } else if (message.type === "error") {
            this.unavailableReason = message.message ?? "Native pill could not start";
          }
        } catch { /* Ignore helper diagnostics that are not protocol messages. */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000); });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.unavailableReason = `Native pill unavailable: ${error.message}`;
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.retryAfter = Date.now() + 10_000;
      if (code && code !== 0) this.unavailableReason = (stderr.trim().split(/\r?\n/).at(-1) || `Native pill exited with code ${code}`).slice(0, 240);
    });
  }

  private layerShellLibrary(): string | null {
    if (this.resolvedLibrary !== undefined) return this.resolvedLibrary;
    const result = spawnSync("pkg-config", ["--variable=libdir", "gtk4-layer-shell-0"], { encoding: "utf8", windowsHide: true });
    const directory = result.status === 0 ? result.stdout.trim() : "";
    const candidates = [
      directory && join(directory, "libgtk4-layer-shell.so"),
      "/usr/lib/libgtk4-layer-shell.so",
      "/usr/lib64/libgtk4-layer-shell.so",
      "/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so.0",
    ].filter(Boolean) as string[];
    this.resolvedLibrary = candidates.find(existsSync) ?? null;
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
