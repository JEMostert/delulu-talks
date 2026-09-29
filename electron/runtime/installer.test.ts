import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuntimeInstaller } from "./installer";
import { runtimePython, runtimeDirectory, activateRuntime } from "./location";
import { DEFAULT_SETTINGS } from "../../src/data";
import { PYTHON_INVENTORY_PROBE, type RuntimeInventory } from "./inventory";
import {
  INSTALLER_PACKAGES,
  MAGIC_PACKAGES,
  METAL_PACKAGES,
  RUNTIME_REVISION,
  SPEECH_PACKAGES,
  WINDOWS_CUDA_PACKAGES,
  WINDOWS_SPEECH_PACKAGES,
} from "./manifest";

// Deliberately Linux observations even in Windows/Mac selection simulations:
// target intent must never be substituted for observed interpreter metadata.
function observedInventory(python: string): string {
  const distributions = [
    { name: "pip", version: "26.2.1" },
    { name: "NumPy", version: "2.3.5" },
    { name: "transitive-only", version: "1.7.4" },
  ];
  return JSON.stringify({
    interpreter: {
      executable: python,
      version: "3.12.9",
      fullVersion: "3.12.9 (fixture)",
      implementation: "CPython",
      prefix: dirname(dirname(python)),
      basePrefix: "/fixture/base-python",
      platform: "linux",
      system: "Linux",
      release: "fixture-kernel",
      machine: "x86_64",
      pointerBits: 64,
    },
    distributions,
    distributionCount: distributions.length,
  });
}

function installedInventory(root: string, kind = "speech"): RuntimeInventory {
  return JSON.parse(
    readFileSync(
      join(runtimeDirectory(root), `runtime-${kind}-inventory.json`),
      "utf8",
    ),
  );
}

for (const failure of [
  "none",
  "install",
  "check",
  "import",
  "interrupted",
  "inventory-probe",
  "inventory-json",
  "inventory-metadata",
  "inventory-write",
  "inventory-cancel",
] as const) {
  test(`runtime activation is transactional: ${failure}`, async () => {
    const data = mkdtempSync(join(tmpdir(), "delulu-migration-"));
    const root = join(data, "speech-venv");
    const oldPython = runtimePython(root);
    mkdirSync(dirname(oldPython), { recursive: true });
    writeFileSync(oldPython, "previous working runtime");
    const installer = new RuntimeInstaller(
      { dataDirectory: data, venvDirectory: root },
      null,
      () => process.env,
      false,
    );
    const commands: string[] = [];
    Object.defineProperty(installer, "run", {
      value: async (program: string, args: string[]) => {
        expect(runtimePython(root)).toBe(oldPython);
        const command = args.join(" ");
        commands.push(command);
        if (args.includes(PYTHON_INVENTORY_PROBE)) {
          if (failure === "inventory-probe")
            throw new Error("simulated failure");
          if (failure === "inventory-json") return '{"interpreter":';
          if (failure === "inventory-metadata") return "{}";
          if (failure === "inventory-write")
            mkdirSync(
              join(dirname(dirname(program)), "runtime-speech-inventory.json"),
            );
          if (failure === "inventory-cancel") installer.stop();
          return observedInventory(program);
        }
        if (command.includes("version_info")) return "3.11";
        if (
          (failure === "install" && command.includes("git+")) ||
          (failure === "check" && command.includes("pip check")) ||
          (failure === "import" && command.includes("from qwen_asr")) ||
          (failure === "interrupted" && command.includes("venv"))
        )
          throw new Error("simulated failure");
        return "test-package==1.0";
      },
    });
    try {
      const install = installer.install("speech", DEFAULT_SETTINGS, () => {});
      if (failure === "none") {
        await install;
        expect(runtimePython(root)).not.toBe(oldPython);
        expect(
          new RuntimeInstaller(
            { dataDirectory: data, venvDirectory: root },
            null,
            () => process.env,
            false,
          ).python,
        ).toBe(runtimePython(root));
        expect(commands.some((c) => c.includes("pip check"))).toBe(true);
        expect(commands.some((c) => c.includes("from qwen_asr"))).toBe(true);
        const inventory = installedInventory(root);
        expect(inventory.runtime.revision).toBe(RUNTIME_REVISION);
        expect(inventory.observed.distributions).toContainEqual({
          name: "transitive-only",
          version: "1.7.4",
        });
        expect(
          readFileSync(
            join(runtimeDirectory(root), "runtime-speech-installed.txt"),
            "utf8",
          ),
        ).toContain("test-package==1.0");
        installer.rollback();
        expect(runtimePython(root)).toBe(oldPython);
      } else {
        await expect(install).rejects.toThrow(
          failure === "inventory-json" || failure === "inventory-metadata"
            ? "Could not validate runtime dependency inventory"
            : failure === "inventory-write"
              ? "Could not write runtime dependency inventory"
              : failure === "inventory-cancel"
                ? "Runtime setup cancelled"
                : "simulated failure",
        );
        expect(runtimePython(root)).toBe(oldPython);
      }
      expect(readFileSync(oldPython, "utf8")).toBe("previous working runtime");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
}

test("activation rejects paths outside the runtime generations", () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-pointer-"));
  try {
    writeFileSync(
      join(root, "active.json"),
      JSON.stringify({ generation: "../../other" }),
    );
    expect(() => runtimePython(root)).toThrow("Invalid runtime activation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readiness is reused for a validated interpreter but not a different generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-readiness-"));
  const installer = new RuntimeInstaller(
    { dataDirectory: root, venvDirectory: root },
    null,
    () => process.env,
  );
  let calls = 0;
  Object.defineProperty(installer, "run", {
    value: async () => {
      calls++;
      return "";
    },
  });
  const makePython = () => {
    mkdirSync(dirname(installer.python), { recursive: true });
    writeFileSync(installer.python, "");
  };
  try {
    makePython();
    expect(await installer.ready("speech")).toBe(true);
    expect(await installer.ready("speech")).toBe(true);
    expect(calls).toBe(1);
    activateRuntime(root, "12345678-1234-1234-1234-123456789abc");
    makePython();
    expect(await installer.ready("speech")).toBe(true);
    expect(calls).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failDownload of [false, true]) {
  test(`MLX installation and download recovery: ${failDownload}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "delulu-metal-"));
    const oldPython = runtimePython(root);
    mkdirSync(dirname(oldPython), { recursive: true });
    writeFileSync(oldPython, "previous runtime");
    const installer = new RuntimeInstaller(
      { dataDirectory: root, venvDirectory: root },
      null,
      () => process.env,
      true,
      false,
      { platform: "darwin", arch: "arm64" },
    );
    let fail = failDownload;
    const commands: string[] = [];
    Object.defineProperty(installer, "run", {
      value: async (program: string, args: string[]) => {
        const command = args.join(" ");
        commands.push(command);
        if (args.includes(PYTHON_INVENTORY_PROBE))
          return observedInventory(program);
        if (command.includes("print('.'.join")) return "3.12";
        if (command.includes("mlx-audio[stt]") && fail)
          throw new Error("Download interrupted");
        return "";
      },
    });
    try {
      if (fail) {
        await expect(
          installer.install("speech", DEFAULT_SETTINGS, () => {}),
        ).rejects.toThrow("Download interrupted");
        expect(runtimePython(root)).toBe(oldPython);
        fail = false;
      }
      await installer.install("speech", DEFAULT_SETTINGS, () => {});
      expect(runtimePython(root)).not.toBe(oldPython);
      expect(
        commands.some((c) => c.includes("platform.machine() == 'arm64'")),
      ).toBe(true);
      expect(commands.some((c) => c.includes("mlx-audio[stt]"))).toBe(true);
      expect(commands.some((c) => c.includes("mlx==0.32.2"))).toBe(true);
      expect(
        commands.some((c) =>
          c.includes("from mlx_audio.stt.utils import load_model, load_audio"),
        ),
      ).toBe(true);
      installer.rollback();
      expect(runtimePython(root)).toBe(oldPython);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Metal refuses Python other than native 3.12 before downloading packages", async () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-python-"));
  const installer = new RuntimeInstaller(
    { dataDirectory: root, venvDirectory: root },
    null,
    () => process.env,
    true,
  );
  const commands: string[] = [];
  Object.defineProperty(installer, "run", {
    value: async (_: string, args: string[]) => {
      commands.push(args.join(" "));
      return "3.13";
    },
  });
  try {
    await expect(
      installer.install("speech", DEFAULT_SETTINGS, () => {}),
    ).rejects.toThrow("native arm64 Python 3.12");
    expect(commands.every((c) => !c.includes("pip install"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["none", "cuda", "decoder-import"] as const) {
  test(`Windows native CUDA install and transaction: ${failure}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "delulu-windows-"));
    const oldPython = runtimePython(root);
    mkdirSync(dirname(oldPython), { recursive: true });
    writeFileSync(oldPython, "previous runtime");
    const installer = new RuntimeInstaller(
      { dataDirectory: root, venvDirectory: root },
      "/linux-constraints.txt",
      () => process.env,
      false,
      true,
      { platform: "win32", arch: "x64" },
    );
    const commands: string[] = [];
    Object.defineProperty(installer, "run", {
      value: async (program: string, args: string[]) => {
        const command = args.join(" ");
        commands.push(command);
        if (args.includes(PYTHON_INVENTORY_PROBE))
          return observedInventory(program);
        if (command.includes("version_info") && command.includes("print"))
          return "3.12";
        if (
          (failure === "cuda" && command.includes("--index-url")) ||
          (failure === "decoder-import" &&
            command.includes("torch.cuda.is_available"))
        )
          throw new Error("Windows validation failed");
        return "";
      },
    });
    try {
      if (failure === "none") {
        await installer.install("speech", DEFAULT_SETTINGS, () => {});
        expect(runtimePython(root)).not.toBe(oldPython);
        expect(
          commands.some((c) =>
            c.includes(
              "--index-url https://download.pytorch.org/whl/cu130 torch==2.13.0+cu130 torchvision==0.28.0+cu130",
            ),
          ),
        ).toBe(true);
        expect(commands.some((c) => c.includes("transformers==5.15.0"))).toBe(
          true,
        );
        expect(
          commands.some((c) => c.includes("torch.cuda.is_available")),
        ).toBe(true);
        expect(
          commands.some((c) => c.includes("Qwen3ASRFeatureExtractor")),
        ).toBe(true);
        expect(commands.some((c) => c.includes("pip check"))).toBe(true);
        expect(
          commands.every(
            (c) =>
              !c.includes("git+") &&
              !c.includes("vllm") &&
              !c.includes("nagisa") &&
              !c.includes("--constraint"),
          ),
        ).toBe(true);
      } else {
        await expect(
          installer.install("speech", DEFAULT_SETTINGS, () => {}),
        ).rejects.toThrow("Windows validation failed");
        expect(runtimePython(root)).toBe(oldPython);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Windows rejects unsupported Python before CUDA downloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-windows-python-"));
  const installer = new RuntimeInstaller(
    { dataDirectory: root, venvDirectory: root },
    null,
    () => process.env,
    false,
    true,
  );
  const commands: string[] = [];
  Object.defineProperty(installer, "run", {
    value: async (_: string, args: string[]) => {
      commands.push(args.join(" "));
      return "3.13";
    },
  });
  try {
    await expect(
      installer.install("speech", DEFAULT_SETTINGS, () => {}),
    ).rejects.toThrow("Install Python 3.12");
    expect(commands.every((c) => !c.includes("pip install"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const target of [
  { platform: "linux", arch: "x64", metal: false, windows: false },
  { platform: "linux", arch: "arm64", metal: false, windows: false },
  { platform: "darwin", arch: "arm64", metal: true, windows: false },
  { platform: "win32", arch: "x64", metal: false, windows: true },
]) {
  for (const kind of ["speech", "magic"] as const) {
    test(`inventory records executed stages and observed packages: ${target.platform}/${target.arch} ${kind}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "delulu-inventory-stages-"));
      const constraints = join(root, "constraints.txt");
      const constraintContents = "# fixture constraint\nNumPy==2.3.5\n";
      writeFileSync(constraints, constraintContents);
      const commands: string[][] = [];
      const installer = new RuntimeInstaller(
        { dataDirectory: root, venvDirectory: root },
        constraints,
        () => process.env,
        target.metal,
        target.windows,
        { platform: target.platform, arch: target.arch },
      );
      let observation = "";
      Object.defineProperty(installer, "run", {
        value: async (program: string, args: string[]) => {
          commands.push(args);
          expect(readFileSync(constraints, "utf8")).toBe(constraintContents);
          if (args.includes(PYTHON_INVENTORY_PROBE)) {
            observation = observedInventory(program);
            return observation;
          }
          if (args.join(" ").includes("print('.'.join")) return "3.12";
          return "pip==26.2.1\nNumPy==2.3.5\ntransitive-only==1.7.4";
        },
      });
      try {
        await installer.install(kind, DEFAULT_SETTINGS, () => {});
        const inventory = installedInventory(root, kind);
        expect(inventory.schemaVersion).toBe(1);
        expect(Number.isNaN(Date.parse(inventory.createdAt))).toBe(false);
        expect(inventory.runtime.kind).toBe(kind);
        expect(inventory.runtime.target).toEqual({
          platform: target.platform,
          arch: target.arch,
        });
        expect(inventory.runtime.generation).toBe(
          JSON.parse(readFileSync(join(root, "active.json"), "utf8"))
            .generation,
        );
        expect(inventory.runtime.backend).toEqual(
          kind === "magic"
            ? { engine: "transformers", devicePreference: ["cuda", "mps"] }
            : target.metal
              ? { engine: "mlx-audio", devicePreference: ["metal"] }
              : {
                  engine: target.windows ? "transformers" : "qwen-asr-vllm",
                  devicePreference: ["cuda"],
                },
        );
        expect(inventory.observed).toEqual(JSON.parse(observation));
        expect(inventory.observed.interpreter.platform).toBe("linux");
        expect(inventory.observed.interpreter.machine).toBe("x86_64");
        expect(inventory.observed.distributions).toContainEqual({
          name: "transitive-only",
          version: "1.7.4",
        });
        expect(inventory.requested[0].requirements).toEqual(INSTALLER_PACKAGES);
        const main = inventory.requested.at(-1)!;
        expect(main.requirements).toEqual(
          kind === "magic"
            ? MAGIC_PACKAGES
            : target.metal
              ? METAL_PACKAGES
              : target.windows
                ? WINDOWS_SPEECH_PACKAGES
                : SPEECH_PACKAGES,
        );
        const appliedConstraint =
          target.platform === "linux" && target.arch === "x64";
        expect(main.constraint).toEqual(
          appliedConstraint
            ? { path: constraints, contents: constraintContents }
            : null,
        );
        if (target.windows) {
          expect(inventory.requested[1].name).toBe("windows-cuda");
          expect(inventory.requested[1].requirements).toEqual(
            WINDOWS_CUDA_PACKAGES,
          );
          expect(inventory.requested[1].pipArguments).toContain(
            "https://download.pytorch.org/whl/cu130",
          );
          if (kind === "magic") {
            // Both requests are retained; resolved versions come only from Python.
            expect(inventory.requested[1].requirements).toContain(
              "torch==2.13.0+cu130",
            );
            expect(main.requirements).toContain("torch==2.13.0");
          }
        }
        expect(inventory.requested.map((s) => s.pipArguments)).toEqual(
          commands
            .filter((args) => args[0] === "-m" && args[2] === "install")
            .map((args) => args.slice(2)),
        );
        expect(
          commands.filter((args) => args.includes(PYTHON_INVENTORY_PROBE)),
        ).toEqual([["-B", "-c", PYTHON_INVENTORY_PROBE]]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const failure of ["probe", "parse", "validation", "write"] as const) {
  test(`inventory failure retains active generation and pointer bytes: ${failure}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "delulu-inventory-recovery-"));
    const generation = "12345678-1234-1234-1234-123456789abc";
    activateRuntime(root, generation);
    const oldPython = runtimePython(root);
    mkdirSync(dirname(oldPython), { recursive: true });
    writeFileSync(oldPython, "previous generation interpreter");
    const oldInventory = join(
      runtimeDirectory(root),
      "runtime-speech-inventory.json",
    );
    writeFileSync(oldInventory, "previous generation report");
    const pointer = readFileSync(join(root, "active.json"));
    const installer = new RuntimeInstaller(
      { dataDirectory: root, venvDirectory: root },
      null,
      () => process.env,
      false,
      false,
    );
    let candidate = "";
    Object.defineProperty(installer, "run", {
      value: async (program: string, args: string[]) => {
        expect(runtimePython(root)).toBe(oldPython);
        if (args.includes(PYTHON_INVENTORY_PROBE)) {
          candidate = dirname(dirname(program));
          if (failure === "probe") throw new Error("metadata unavailable");
          if (failure === "parse") return "{truncated";
          if (failure === "validation") {
            const observed = JSON.parse(observedInventory(program));
            observed.distributionCount++;
            return JSON.stringify(observed);
          }
          mkdirSync(join(candidate, "runtime-speech-inventory.json"));
          return observedInventory(program);
        }
        if (args.join(" ").includes("print('.'.join")) return "3.12";
        return "pip==26.2.1";
      },
    });
    try {
      await expect(
        installer.install("speech", DEFAULT_SETTINGS, () => {}),
      ).rejects.toThrow("The previous environment is unchanged");
      expect(runtimePython(root)).toBe(oldPython);
      expect(readFileSync(oldPython, "utf8")).toBe(
        "previous generation interpreter",
      );
      expect(readFileSync(oldInventory, "utf8")).toBe(
        "previous generation report",
      );
      expect(readFileSync(join(root, "active.json"))).toEqual(pointer);
      expect(readdirSync(candidate).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
