import { EventEmitter } from "node:events";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

mock.module("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/tmp/delulu" } }));

let PillService: typeof import("./pill")["PillService"];
let layerShellCandidates: typeof import("./pill")["layerShellCandidates"];
let resolveSystemPython: typeof import("./pill")["resolveSystemPython"];
type PillIo = import("./pill").PillIo;

beforeAll(async () => {
  ({ PillService, layerShellCandidates, resolveSystemPython } = await import("./pill"));
});

class FakeChild extends EventEmitter {
  readonly stdin = {
    writable: true,
    writes: [] as string[],
    write: (value: string) => {
      this.stdin.writes.push(value);
      return true;
    },
    end: () => undefined,
  };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

function readyChild(): FakeChild {
  const child = new FakeChild();
  queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`)));
  return child;
}

function io(overrides: Partial<{ children: FakeChild[]; exists: Set<string>; now: number }> = {}): { io: PillIo; children: FakeChild[] } {
  const children = overrides.children ?? [];
  const exists = overrides.exists ?? new Set(["/tmp/pill.py", "/usr/lib/libgtk4-layer-shell.so", "/usr/bin/python3"]);
  const now = overrides.now ?? 1_000;
  return {
    children,
    io: {
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland" },
      scriptPath: () => "/tmp/pill.py",
      now: () => now,
      existsSync: (path) => exists.has(String(path)),
      spawnSync: ((command: string) => {
        if (command === "which") return { status: 0, stdout: "/usr/bin/python3\n" };
        if (command === "pkg-config") return { status: 0, stdout: "/usr/lib\n" };
        return { status: 1, stdout: "" };
      }) as NonNullable<PillIo["spawnSync"]>,
      spawn: ((() => {
        const child = children.shift() ?? readyChild();
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as unknown) as NonNullable<PillIo["spawn"]>,
    },
  };
}

describe("pill helper resolution", () => {
  test("prefers python3 from PATH when the file exists", () => {
    const python = resolveSystemPython(
      {},
      ((command: string) => command === "which" ? { status: 0, stdout: "/opt/bin/python3\n" } : { status: 1, stdout: "" }) as typeof import("node:child_process").spawnSync,
      (path) => path === "/opt/bin/python3",
    );
    expect(python).toBe("/opt/bin/python3");
  });

  test("includes the pkg-config libdir before distro fallbacks", () => {
    expect(layerShellCandidates("/usr/lib/x86_64-linux-gnu")[0]).toBe("/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so");
  });
});

describe("pill process protocol", () => {
  test("replays the desired state after the helper becomes ready", async () => {
    const child = new FakeChild();
    const testIo = io({ children: [child] });
    const pill = new PillService(testIo.io);
    pill.show({ state: "listening", detail: "Release to send" });
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`));
    expect(child.stdin.writes).toEqual([`${JSON.stringify({ state: "listening", detail: "Release to send" })}\n`]);
  });

  test("retries once with LD_PRELOAD if the first helper start fails", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const testIo = io({ children: [first, second] });
    const pill = new PillService(testIo.io);
    pill.prepare();
    first.emit("exit", 1);
    second.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`));
    expect(pill.method).toBe("layer-shell");
    expect(second.stdin.writes).toEqual([`${JSON.stringify({ state: "hidden" })}\n`]);
  });

  test("retries with LD_PRELOAD when the helper exits before becoming ready", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const testIo = io({ children: [first, second] });
    const pill = new PillService(testIo.io);
    pill.show({ state: "listening" });
    first.emit("exit", 0);
    second.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`));
    expect(second.stdin.writes).toEqual([`${JSON.stringify({ state: "listening" })}\n`]);
  });

  test("recovers when the helper cannot be spawned", () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const testIo = io({ children: [first, second] });
    const pill = new PillService(testIo.io);
    pill.show({ state: "listening" });
    first.emit("error", new Error("spawn python3 ENOENT"));
    second.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`));
    expect(second.stdin.writes).toEqual([`${JSON.stringify({ state: "listening" })}\n`]);
    expect(pill.method).toBe("layer-shell");
  });

  test("forwards a live level only while listening", () => {
    const child = new FakeChild();
    const testIo = io({ children: [child] });
    const pill = new PillService(testIo.io);
    pill.show({ state: "listening" });
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "ready" })}\n`));
    pill.level(0.4);
    pill.show({ state: "transcribing" });
    pill.level(0.9);
    expect(child.stdin.writes).toEqual([
      `${JSON.stringify({ state: "listening" })}\n`,
      `${JSON.stringify({ state: "listening", level: 0.4 })}\n`,
      `${JSON.stringify({ state: "transcribing" })}\n`,
    ]);
  });

  test("does not start on X11 or when the helper is missing", () => {
    const spawned: string[] = [];
    const missing = new PillService({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "wayland" },
      scriptPath: () => "/missing/pill.py",
      existsSync: () => false,
      spawn: ((() => {
        spawned.push("spawn");
        return readyChild() as unknown as ChildProcessWithoutNullStreams;
      }) as unknown) as NonNullable<PillIo["spawn"]>,
    });
    missing.show({ state: "listening" });
    const x11 = new PillService({
      platform: "linux",
      env: { XDG_SESSION_TYPE: "x11" },
      scriptPath: () => "/tmp/pill.py",
      existsSync: () => true,
      spawn: ((() => {
        spawned.push("spawn");
        return readyChild() as unknown as ChildProcessWithoutNullStreams;
      }) as unknown) as NonNullable<PillIo["spawn"]>,
    });
    x11.show({ state: "listening" });
    expect(spawned).toEqual([]);
    expect(missing.method).toBe("unavailable");
    expect(x11.method).toBe("unavailable");
  });
});
