import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import { RuntimeInstaller, type InstallProgress } from "./installer";
import { activateRuntime, runtimeDirectory, runtimePython } from "./location";
import { createSetupFixture, type SetupStage } from "./fixtures/setupPython";

// The executable fixture uses POSIX shebangs. Windows/MLX backend selection
// below runs on the host and is synthetic, not native platform evidence.
const processTest = test.skipIf(process.platform === "win32");
const permissionTest = test.skipIf(
  process.platform === "win32" || process.geteuid?.() === 0,
);
type Kind = "speech" | "magic";
const oldGeneration = "12345678-1234-1234-1234-123456789abc";
const platforms = {
  linux: { platform: "linux", arch: "x64", metal: false, windows: false },
  mlx: { platform: "darwin", arch: "arm64", metal: true, windows: false },
  windows: { platform: "win32", arch: "x64", metal: false, windows: true },
};

async function bounded<T>(promise: Promise<T>, timeout = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Setup fixture timed out")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function waitUntil<T>(read: () => T | undefined): Promise<T> {
  let timer: ReturnType<typeof setInterval>;
  try {
    return await bounded(
      new Promise<T>((resolve) => {
        timer = setInterval(() => {
          const result = read();
          if (result !== undefined) resolve(result);
        }, 10);
      }),
    );
  } finally {
    clearInterval(timer!);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function scenario(kind: Kind, platform: keyof typeof platforms = "linux") {
  const profile = mkdtempSync(join(tmpdir(), "delulu-setup-process-"));
  const fixture = createSetupFixture(join(profile, "commands"));
  const root = join(profile, `${kind}-venv`);
  const otherRoot = join(
    profile,
    `${kind === "speech" ? "magic" : "speech"}-venv`,
  );
  const preserved = new Map<string, Buffer<ArrayBuffer>>();
  const save = (path: string, value: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    preserved.set(path, readFileSync(path));
  };
  for (const runtime of [root, otherRoot]) {
    const runtimeKind =
      runtime === root ? kind : kind === "speech" ? "magic" : "speech";
    mkdirSync(runtime);
    activateRuntime(runtime, oldGeneration);
    preserved.set(
      join(runtime, "active.json"),
      readFileSync(join(runtime, "active.json")),
    );
    save(
      runtimePython(runtime),
      `${readFileSync(fixture.program, "utf8")}\n// Previous runtime ${JSON.stringify(runtime)}\n`,
    );
    chmodSync(runtimePython(runtime), 0o700);
    save(
      join(runtimeDirectory(runtime), `runtime-${runtimeKind}-installed.txt`),
      "prior package report\n",
    );
    save(
      join(runtimeDirectory(runtime), `runtime-${runtimeKind}-inventory.json`),
      '{"prior":true}\n',
    );
  }
  save(
    join(profile, "settings.json"),
    '{"language":"en","preserve":"settings"}\n',
  );
  save(
    join(profile, "history.json"),
    '[{"original":"Retained transcript 🎙️"}]\n',
  );
  const target = platforms[platform];
  const makeInstaller = () =>
    new RuntimeInstaller(
      { dataDirectory: profile, venvDirectory: root },
      null,
      () => ({
        ...fixture.environment,
        DELULU_SETUP_FIXTURE_MACHINE:
          target.arch === "arm64" ? "arm64" : "x86_64",
      }),
      target.metal,
      target.windows,
      { platform: target.platform, arch: target.arch },
    );
  const installer = makeInstaller();
  const settings = {
    ...DEFAULT_SETTINGS,
    pythonCommand: `"${fixture.program}"`,
  };
  const assertPreserved = (includePointer = true) => {
    for (const [path, contents] of preserved) {
      if (!includePointer && path === join(root, "active.json")) continue;
      expect(readFileSync(path)).toEqual(contents);
    }
    if (includePointer)
      expect(runtimeDirectory(root)).toBe(
        join(root, "generations", oldGeneration),
      );
  };
  const inactiveCandidate = () => {
    const candidates = readdirSync(join(root, "generations")).filter(
      (name) => name !== oldGeneration,
    );
    expect(candidates).toHaveLength(1);
    return join(root, "generations", candidates[0]);
  };
  return {
    profile,
    root,
    fixture,
    installer,
    settings,
    assertPreserved,
    inactiveCandidate,
    async assertPriorReady() {
      // A fresh reader proves old interpreter usability, even after stop() has
      // deliberately cancelled the original installer's command runner.
      expect(await bounded(makeInstaller().ready(kind))).toBe(true);
    },
    cleanup() {
      installer.stop();
      if (existsSync(root)) chmodSync(root, 0o700);
      for (const entry of fixture.readLog()) {
        if (entry.event === "paused" && alive(entry.pid))
          process.kill(entry.pid, "SIGKILL");
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function retry(
  context: ReturnType<typeof scenario>,
  kind: Kind,
  failedCandidate: string,
): Promise<void> {
  await context.assertPriorReady();
  context.fixture.writeControl({});
  const progress: InstallProgress[] = [];
  const logOffset = context.fixture.readLog().length;
  await bounded(
    context.installer.install(kind, context.settings, (event) =>
      progress.push(event),
    ),
  );
  // Installer preparation cannot activate a runtime before its caller validates it.
  context.installer.commit();
  const active = runtimeDirectory(context.root);
  expect(active).not.toBe(failedCandidate);
  expect(active).not.toBe(join(context.root, "generations", oldGeneration));
  expect(existsSync(failedCandidate)).toBe(true);
  expect(existsSync(join(active, "download.partial"))).toBe(false);
  expect(readFileSync(join(active, "download.complete"), "utf8")).toBe(
    "complete synthetic download",
  );
  expect(
    readFileSync(join(active, `runtime-${kind}-installed.txt`), "utf8"),
  ).toContain("setup-fixture-package==1.0.0");
  const inventory = JSON.parse(
    readFileSync(join(active, `runtime-${kind}-inventory.json`), "utf8"),
  );
  expect(inventory.observed.interpreter.implementation).toBe(
    "SyntheticFixture",
  );
  expect(inventory.observed.distributions).toEqual([
    { name: "setup-fixture-package", version: "1.0.0" },
  ]);
  expect(
    JSON.parse(readFileSync(join(context.root, "active.json"), "utf8"))
      .previous,
  ).toBe(oldGeneration);
  expect(
    progress.filter((event) =>
      event.message.startsWith("Runtime candidate prepared."),
    ),
  ).toHaveLength(1);
  const stages = context.fixture
    .readLog()
    .slice(logOffset)
    .filter((entry) => entry.event === "finished")
    .map((entry) => entry.stage);
  const expectedStages: SetupStage[] = [
    "interpreter",
    "venv",
    "installer",
    ...(context.installer.python.includes("Scripts") ||
    inventory.runtime.target.platform === "win32"
      ? ["cuda" as const]
      : []),
    "runtime",
    "check",
    "readiness",
    "freeze",
    "inventory",
  ];
  // Resolution and installation each execute the same package stage.
  expect(stages).toEqual(
    expectedStages.flatMap((stage) =>
      ["installer", "cuda", "runtime"].includes(stage)
        ? [stage, stage]
        : [stage],
    ),
  );
  context.assertPreserved(false);
}

for (const kind of ["speech", "magic"] as const) {
  permissionTest(
    `activation write denied after reports complete preserves prior runtime: ${kind}`,
    async () => {
      const context = scenario(kind);
      const progress: InstallProgress[] = [];
      context.fixture.writeControl({ blockActivationWrite: true });
      try {
        await expect(
          bounded(
            context.installer
              .install(kind, context.settings, (event) => progress.push(event))
              .then(() => context.installer.commit()),
          ),
        ).rejects.toThrow("EACCES");
        context.assertPreserved();
        expect(
          progress.some((event) =>
            event.message.startsWith("Runtime candidate prepared."),
          ),
        ).toBe(true);
        const candidate = context.inactiveCandidate();
        expect(
          existsSync(join(candidate, `runtime-${kind}-inventory.json`)),
        ).toBe(true);
        expect(
          readdirSync(context.root).some((name) => name.endsWith(".tmp")),
        ).toBe(false);
        expect(context.fixture.readLog().at(-1)?.event).toBe("finished");
        chmodSync(context.root, 0o700);
        await retry(context, kind, candidate);
      } finally {
        context.cleanup();
      }
    },
  );
}

for (const kind of ["speech", "magic"] as const) {
  for (const stage of [
    "interpreter",
    "venv",
    "installer",
    "runtime",
    "check",
    "readiness",
    "freeze",
    "inventory",
  ] as const) {
    processTest(
      `real child setup failure preserves runtime and retries: ${kind}/${stage}`,
      async () => {
        const context = scenario(kind);
        const progress: InstallProgress[] = [];
        context.fixture.writeControl({ failStage: stage });
        try {
          await expect(
            bounded(
              context.installer.install(kind, context.settings, (event) => {
                progress.push(event);
                context.assertPreserved();
              }),
            ),
          ).rejects.toThrow(
            stage === "interpreter"
              ? "[PYTHON_VERSION]"
              : `Synthetic setup failure at ${stage}`,
          );
          context.assertPreserved();
          expect(
            progress.some((event) =>
              event.message.startsWith("Runtime candidate prepared."),
            ),
          ).toBe(false);
          const failure = context.fixture
            .readLog()
            .find((entry) => entry.event === "failed");
          expect(failure?.stage).toBe(stage);
          expect(failure?.pid).not.toBe(process.pid);
          expect(alive(failure!.pid)).toBe(false);
          await retry(context, kind, context.inactiveCandidate());
        } finally {
          context.cleanup();
        }
      },
    );
  }
  processTest(
    `real child Windows CUDA stage failure preserves runtime and retries: ${kind}`,
    async () => {
      const context = scenario(kind, "windows");
      const progress: InstallProgress[] = [];
      context.fixture.writeControl({ failStage: "cuda" });
      try {
        await expect(
          bounded(
            context.installer.install(kind, context.settings, (event) =>
              progress.push(event),
            ),
          ),
        ).rejects.toThrow("Synthetic setup failure at cuda");
        context.assertPreserved();
        expect(
          progress.some((event) =>
            event.message.startsWith("Runtime candidate prepared."),
          ),
        ).toBe(false);
        const command = context.fixture
          .readLog()
          .find((entry) => entry.stage === "cuda")!;
        expect(command.args).toContain(
          "https://download.pytorch.org/whl/cu130",
        );
        expect(command.args).toContain("torch==2.13.0+cu130");
        expect(alive(command.pid)).toBe(false);
        await retry(context, kind, context.inactiveCandidate());
      } finally {
        context.cleanup();
      }
    },
  );
  for (const stage of ["freeze", "inventory"] as const) {
    processTest(
      `real report write failure preserves runtime and retries: ${kind}/${stage}`,
      async () => {
        const context = scenario(kind);
        const progress: InstallProgress[] = [];
        context.fixture.writeControl({ blockReportWrite: stage });
        try {
          await expect(
            bounded(
              context.installer.install(kind, context.settings, (event) =>
                progress.push(event),
              ),
            ),
          ).rejects.toThrow(
            stage === "freeze"
              ? "EISDIR"
              : "Could not write runtime dependency inventory",
          );
          context.assertPreserved();
          expect(
            progress.some((event) =>
              event.message.startsWith("Runtime candidate prepared."),
            ),
          ).toBe(false);
          const commands = context.fixture.readLog();
          expect(commands.some((entry) => entry.event === "failed")).toBe(
            false,
          );
          expect(commands.at(-1)?.stage).toBe(stage);
          expect(commands.at(-1)?.event).toBe("finished");
          const candidate = context.inactiveCandidate();
          const artifact = join(
            candidate,
            `runtime-${kind}-${stage === "freeze" ? "installed.txt" : "inventory.json"}`,
          );
          expect(statSync(artifact).isDirectory()).toBe(true);
          expect(
            readdirSync(candidate).some((name) => name.endsWith(".tmp")),
          ).toBe(false);
          await retry(context, kind, candidate);
        } finally {
          context.cleanup();
        }
      },
    );
  }
}

for (const [kind, platform, stage] of [
  ["speech", "linux", "installer"],
  ["speech", "linux", "runtime"],
  ["magic", "linux", "runtime"],
  ["speech", "mlx", "runtime"],
  ["speech", "windows", "cuda"],
  ["magic", "windows", "runtime"],
  ["speech", "linux", "freeze"],
  ["magic", "linux", "inventory"],
] as const) {
  processTest(
    `stop kills real child mid-operation; retry uses clean generation: ${kind}/${platform}/${stage}`,
    async () => {
      const context = scenario(kind, platform);
      const progress: InstallProgress[] = [];
      context.fixture.writeControl({ pauseStage: stage });
      const install = context.installer.install(
        kind,
        context.settings,
        (event) => progress.push(event),
      );
      // Attach a rejection observer immediately while waiting for the child's
      // pause marker; the original rejection is asserted after cancellation.
      void install.catch(() => {});
      try {
        const paused = await waitUntil(() =>
          context.fixture.readLog().find((entry) => entry.event === "paused"),
        );
        expect(paused.stage).toBe(stage);
        expect(paused.pid).not.toBe(process.pid);
        expect(alive(paused.pid)).toBe(true);
        const partial = join(paused.candidate!, "download.partial");
        const initial = statSync(partial).size;
        expect(initial).toBeGreaterThan(0);
        await waitUntil(() =>
          statSync(partial).size > initial ? true : undefined,
        );
        if (stage !== "freeze" && stage !== "inventory")
          await waitUntil(() =>
            progress.some((event) =>
              event.detail?.includes("fixture-download-paused:"),
            )
              ? true
              : undefined,
          );
        context.assertPreserved();
        expect(
          progress.some((event) =>
            event.message.startsWith("Runtime candidate prepared."),
          ),
        ).toBe(false);
        context.installer.stop();
        await expect(bounded(install, 2000)).rejects.toThrow(
          "Runtime setup cancelled",
        );
        expect(alive(paused.pid)).toBe(false);
        expect(
          context.fixture
            .readLog()
            .some(
              (entry) =>
                entry.pid === paused.pid && entry.event === "terminated",
            ),
        ).toBe(true);
        expect(readFileSync(partial, "utf8")).toStartWith(
          "partial synthetic download",
        );
        context.assertPreserved();
        expect(
          progress.some((event) =>
            event.message.startsWith("Runtime candidate prepared."),
          ),
        ).toBe(false);
        const command = context.fixture
          .readLog()
          .find((entry) => entry.stage === "runtime");
        if (platform === "mlx")
          expect(command!.args).toContain("mlx-audio[stt]==0.5.7");
        await retry(context, kind, paused.candidate!);
      } finally {
        context.cleanup();
      }
    },
  );
}
