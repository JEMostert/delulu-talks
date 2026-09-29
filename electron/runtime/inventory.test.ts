import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeInventory, PYTHON_INVENTORY_PROBE } from "./inventory";

const directory = join(tmpdir(), "inventory-candidate");
const executable = join(directory, "bin/python");
const context = {
  revision: "fixture-revision",
  kind: "speech" as const,
  generation: "12345678-1234-1234-1234-123456789abc",
  backend: {
    engine: "qwen-asr-vllm" as const,
    devicePreference: ["cuda" as const],
  },
  target: { platform: "linux", arch: "x64" },
  python: executable,
  directory,
  requested: [],
};
function observation() {
  return {
    interpreter: {
      executable,
      version: "3.12.9",
      fullVersion: "3.12.9 (fixture)",
      implementation: "CPython",
      prefix: directory,
      basePrefix: "/base-python",
      platform: "linux",
      system: "Linux",
      release: "fixture-kernel",
      machine: "x86_64",
      pointerBits: 64,
    },
    distributions: [{ name: "sample-package", version: "1.2.3+fixture" }],
    distributionCount: 1,
  };
}

test("inventory rejects partial, ambiguous or unrelated interpreter observations", () => {
  expect(() => createRuntimeInventory(context, "{truncated")).toThrow(
    "Could not validate runtime dependency inventory",
  );
  for (const mutate of [
    (value: ReturnType<typeof observation>) => {
      value.interpreter.version = "";
    },
    (value: ReturnType<typeof observation>) => {
      value.interpreter.machine = "";
    },
    (value: ReturnType<typeof observation>) => {
      value.interpreter.pointerBits = 128;
    },
    (value: ReturnType<typeof observation>) => {
      value.interpreter.executable = "/other/python";
    },
    (value: ReturnType<typeof observation>) => {
      value.interpreter.prefix = "/other/venv";
    },
    (value: ReturnType<typeof observation>) => {
      value.interpreter.basePrefix = directory;
    },
    (value: ReturnType<typeof observation>) => {
      value.distributionCount = 2;
    },
    (value: ReturnType<typeof observation>) => {
      value.distributions = [];
      value.distributionCount = 0;
    },
    (value: ReturnType<typeof observation>) => {
      value.distributions[0].version = "";
    },
    (value: ReturnType<typeof observation>) => {
      value.distributions[0].name = "bad\nname";
    },
    (value: ReturnType<typeof observation>) => {
      value.distributions.push({ name: "Sample_Package", version: "4.5.6" });
      value.distributionCount = 2;
    },
  ]) {
    const value = observation();
    mutate(value);
    expect(() =>
      createRuntimeInventory(context, JSON.stringify(value)),
    ).toThrow("Could not validate runtime dependency inventory");
  }
});

test("stdlib probe reads all real candidate distribution metadata without importing packages", () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-inventory-stdlib-"));
  const venv = join(root, "venv");
  const python = join(
    venv,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const basePython = process.platform === "win32" ? "python" : "python3";
  const marker = join(root, "package-was-imported");
  const run = (program: string, args: string[]) =>
    execFileSync(program, args, {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    }).trim();
  try {
    // No pip, network, model libraries or user runtime changes.
    run(basePython, ["-B", "-m", "venv", "--without-pip", venv]);
    const site = run(python, [
      "-B",
      "-c",
      "import sysconfig; print(sysconfig.get_path('purelib'))",
    ]);
    for (const [name, version, dependencies] of [
      [
        "inventory-direct",
        "1.2.3",
        "Requires-Dist: inventory-transitive==4.5.6\n",
      ],
      ["inventory-transitive", "4.5.6", ""],
    ]) {
      const distInfo = join(
        site,
        `${name.replaceAll("-", "_")}-${version}.dist-info`,
      );
      mkdirSync(distInfo, { recursive: true });
      writeFileSync(
        join(distInfo, "METADATA"),
        `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n${dependencies}\n`,
      );
      const packageDirectory = join(site, name.replaceAll("-", "_"));
      mkdirSync(packageDirectory);
      writeFileSync(
        join(packageDirectory, "__init__.py"),
        `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('imported')\nraise RuntimeError('inventory must not import packages')\n`,
      );
    }
    const output = run(python, ["-B", "-c", PYTHON_INVENTORY_PROBE]);
    const inventory = createRuntimeInventory(
      {
        ...context,
        python,
        directory: venv,
        target: { platform: process.platform, arch: process.arch },
        requested: [
          {
            name: "runtime",
            requirements: ["inventory-direct==1.2.3"],
            pipArguments: ["install", "inventory-direct==1.2.3"],
            constraint: null,
          },
        ],
      },
      output,
    );
    expect(inventory.observed.distributions).toEqual([
      { name: "inventory-direct", version: "1.2.3" },
      { name: "inventory-transitive", version: "4.5.6" },
    ]);
    expect(inventory.observed.distributionCount).toBe(2);
    expect(inventory.observed.interpreter.executable).toBe(python);
    expect(inventory.observed.interpreter.prefix).toBe(venv);
    expect(inventory.observed.interpreter.platform).toBe(
      process.platform === "win32" ? "win32" : process.platform,
    );
    expect(inventory.observed.interpreter.implementation).toBe("CPython");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
