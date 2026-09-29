import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { OverlayDiagnostics } from "../../src/types";

export type PillState =
  | "hidden"
  | "listening"
  | "transcribing"
  | "magic"
  | "delivering"
  | "success"
  | "error";

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

export function resolveSystemPython(
  env: NodeJS.ProcessEnv,
  run: typeof spawnSync,
  exists: typeof existsSync,
): string {
  const which = run(
    process.platform === "win32" ? "where" : "which",
    ["python3"],
    {
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 2000,
      maxBuffer: 64 * 1024,
    },
  );
  const located =
    which.status === 0 ? which.stdout.trim().split(/\r?\n/)[0] : "";
  if (located && exists(located)) return located;
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (exists(candidate)) return candidate;
  }
  return "python3";
}

export function layerShellCandidates(pkgConfigDirectory: string): string[] {
  return [
    pkgConfigDirectory && join(pkgConfigDirectory, "libgtk4-layer-shell.so"),
    pkgConfigDirectory && join(pkgConfigDirectory, "libgtk4-layer-shell.so.0"),
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
  private probeResult: OverlayDiagnostics | null = null;
  private probePending: Promise<OverlayDiagnostics> | null = null;
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
    try {
      return this.supportedEnvironment() && this.layerShellLibrary() && !this.unavailableReason
        ? "layer-shell" : "unavailable";
    } catch { return "unavailable"; }
  }

  get detail(): string {
    try {
      if (!this.supportedEnvironment()) return "Native pill requires a Wayland layer-shell compositor";
      if (!this.layerShellLibrary()) return "Install gtk4-layer-shell to enable the native pill";
      return this.unavailableReason ?? (this.ready
        ? "Native layer-shell helper reported ready"
        : "Layer-shell library found; helper readiness not yet reported. Check optional overlay dependencies in Models → Diagnostics.");
    } catch { return "Could not inspect optional overlay dependencies. Capture remains available through Controls."; }
  }

  prepare(): void {
    if (!this.supportedEnvironment() || this.child) return;
    this.desired = { state: "hidden" };
    this.safeStart();
  }

  show(command: {
    state: Exclude<PillState, "hidden">;
    title?: string;
    detail?: string;
    level?: number;
  }): void {
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
    this.desired =
      command.state === "listening"
        ? command
        : {
            state: command.state,
            title: command.title,
            detail: command.detail,
          };
    if (!this.supportedEnvironment()) return;
    if (!this.child && command.state !== "hidden") this.safeStart();
    if (this.ready) this.write(command);
  }

  private markUnavailable(error: unknown): void {
    this.unavailableReason = `Optional overlay unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 320);
    this.ready = false;
    this.retryAfter = this.now() + 10_000;
    const child = this.child;
    this.child = null;
    try { child?.kill(); } catch { /* Optional helper failure never aborts capture. */ }
  }

  private safeStart(): void {
    try { this.start(); } catch (error) { this.markUnavailable(error); }
  }

  async diagnostics(refresh = false): Promise<OverlayDiagnostics> {
    const base: OverlayDiagnostics = {
      platform: this.platform, session: this.env.XDG_SESSION_TYPE ?? "unknown", checkedAt: null,
      status: "not-checked", interpreter: null, library: null, helperReady: this.ready,
      detail: "Dependencies have not been checked. The optional overlay does not control capture; use Controls when unavailable.", checks: [],
    };
    if (!this.supportedEnvironment()) return { ...base, status: "unsupported", detail: "This dependency check is for Linux Wayland layer-shell overlays. Capture remains available through Controls." };
    if (!refresh) return this.probeResult ? { ...this.probeResult, helperReady: this.ready } : base;
    if (this.probePending) return this.probePending;
    this.probePending = this.performProbe(base).finally(() => { this.probePending = null; });
    return this.probePending;
  }

  private async performProbe(base: OverlayDiagnostics): Promise<OverlayDiagnostics> {
    const finish = (patch: Partial<OverlayDiagnostics>) => {
      this.probeResult = { ...base, ...patch, helperReady: this.ready, checkedAt: this.now() };
      return this.probeResult;
    };
    try {
      this.resolvedLibrary = undefined;
      this.resolvedPython = undefined;
      const script = this.scriptPath();
      if (!this.existsSync(script)) return finish({ status: "unavailable", detail: "Overlay helper is missing. Reinstall the app to restore it; capture does not depend on the helper." });
      const python = this.pythonPath();
      const library = this.layerShellLibrary();
      const env: NodeJS.ProcessEnv = { ...this.env, GDK_BACKEND: "wayland", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
      if (this.usePreload && library) env.LD_PRELOAD = this.env.LD_PRELOAD ? `${library}:${this.env.LD_PRELOAD}` : library;
      return await new Promise<OverlayDiagnostics>((resolveProbe) => {
        execFile(python, ["-B", script, "--probe"], { env, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
          if (error) {
            resolveProbe(finish({ status: "unknown", interpreter: python, library, detail: "Dependency probe failed, timed out or exited unexpectedly. Check the system Python, PyGObject/GTK4 bindings and Wayland display permissions. Capture remains independent." }));
            return;
          }
          try {
            const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "");
            if (!Array.isArray(report.checks) || report.checks.length > 12 || !report.checks.length) throw new Error("Invalid report");
            const checks: OverlayDiagnostics["checks"] = report.checks.map((item: unknown) => {
              const entry = item as Record<string, unknown>;
              if (!entry || typeof entry.name !== "string" || typeof entry.detail !== "string" || !["passed", "failed", "unknown"].includes(String(entry.state))) throw new Error("Invalid check");
              return { name: entry.name.slice(0, 80), state: entry.state as "passed" | "failed" | "unknown", detail: entry.detail.slice(0, 320) };
            });
            const expected = ["PyCairo", "PyGObject", "Gtk", "Gdk", "Gtk4LayerShell", "Pango", "Wayland layer-shell protocol"];
            if (checks.length !== expected.length || !expected.every((name) => checks.filter((item) => item.name === name).length === 1)) throw new Error("Incomplete dependency report");
            const available = checks.every((item) => item.state === "passed");
            resolveProbe(finish({ status: available ? "available" : "unavailable", interpreter: python, library, checks, detail: available ? "Dependency imports and compositor protocol check passed at this timestamp. This does not verify visible placement or microphone capture." : "Overlay dependencies or compositor support are unavailable. Install the missing system bindings/library or check the Wayland session. Capture remains available through Controls." }));
          } catch {
            resolveProbe(finish({ status: "unknown", interpreter: python, library, detail: "Dependency probe returned an invalid report. Reinstall the helper or check its Python dependencies; no availability was assumed." }));
          }
        });
      });
    } catch {
      return finish({ status: "unknown", detail: "Could not inspect the optional overlay interpreter/library. Check system permissions; capture is independent." });
    }
  }

  private supportedEnvironment(): boolean {
    return (
      this.platform === "linux" &&
      this.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland"
    );
  }

  private scriptPath(): string {
    if (this.io.scriptPath) return this.io.scriptPath();
    return app.isPackaged
      ? join(process.resourcesPath, "overlay", "pill.py")
      : resolve(app.getAppPath(), "electron", "overlay", "pill.py");
  }

  private pythonPath(): string {
    this.resolvedPython ??= resolveSystemPython(
      this.env,
      this.spawnSync,
      this.existsSync,
    );
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
      this.unavailableReason =
        "Install gtk4-layer-shell to enable the native pill";
      return;
    }
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      GDK_BACKEND: "wayland",
      PYTHONUNBUFFERED: "1",
    };
    if (this.usePreload) {
      // Some hosts need the Wayland shim on the linker path before GTK is imported.
      childEnv.LD_PRELOAD = this.env.LD_PRELOAD
        ? `${layerShellLib}:${this.env.LD_PRELOAD}`
        : layerShellLib;
    }
    const child = this.spawn(this.pythonPath(), [script], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    let stdout = "";
    let stderr = "";
    child.stdin.on("error", (error) => {
      if (this.child === child) this.markUnavailable(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      stdout += chunk.toString();
      if (stdout.length > 64 * 1024) {
        this.markUnavailable(new Error("Overlay helper output exceeded its bound"));
        return;
      }
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as {
            type?: string;
            message?: string;
          };
          if (message.type === "ready") {
            this.ready = true;
            this.unavailableReason = null;
            this.write(this.desired);
          } else if (message.type === "error") {
            this.ready = false;
            this.unavailableReason =
              message.message ?? "Native pill could not start";
          }
        } catch {
          /* Ignore helper diagnostics that are not protocol messages. */
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    let finished = false;
    const finish = (code: number | null, error?: Error) => {
      if (finished || this.child !== child) return;
      finished = true;
      if (error)
        this.unavailableReason = `Native pill unavailable: ${error.message}`;
      const started = this.ready;
      this.child = null;
      this.ready = false;
      const failed =
        !started ||
        Boolean(code && code !== 0) ||
        Boolean(this.unavailableReason);
      if (failed && !this.preloadAttempted && layerShellLib) {
        this.preloadAttempted = true;
        this.usePreload = true;
        this.retryAfter = 0;
        this.safeStart();
        return;
      }
      this.retryAfter = this.now() + 10_000;
      if (!started || (code && code !== 0)) {
        this.unavailableReason = (
          stderr.trim().split(/\r?\n/).at(-1) ||
          this.unavailableReason ||
          `Native pill exited with code ${code ?? 0}`
        ).slice(0, 240);
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
    const result = this.spawnSync(
      "pkg-config",
      ["--variable=libdir", "gtk4-layer-shell-0"],
      { encoding: "utf8", windowsHide: true, env: this.env, timeout: 2000, maxBuffer: 64 * 1024 },
    );
    const directory = result.status === 0 ? result.stdout.trim() : "";
    this.resolvedLibrary =
      layerShellCandidates(directory).find((candidate) =>
        this.existsSync(candidate),
      ) ?? null;
    return this.resolvedLibrary;
  }

  private write(command: PillCommand): void {
    if (!this.child || !this.ready || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      this.markUnavailable(error);
    }
  }

  shutdown(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) return;
    try { child.stdin.end(); } catch { /* Optional helper may already have exited. */ }
    // Electron can exit before a delayed cleanup timer runs.
    try { child.kill("SIGTERM"); } catch { /* Best-effort optional HUD shutdown. */ }
  }
}
