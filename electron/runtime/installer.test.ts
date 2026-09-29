import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RuntimeInstaller } from "./installer";
import { runtimePython, activateRuntime } from "./location";
import { DEFAULT_SETTINGS } from "../../src/data";

for (const failure of [
  "none",
  "install",
  "check",
  "import",
  "interrupted",
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
      value: async (_program: string, args: string[]) => {
        expect(runtimePython(root)).toBe(oldPython);
        const command = args.join(" ");
        commands.push(command);
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
        installer.rollback();
        expect(runtimePython(root)).toBe(oldPython);
      } else {
        await expect(install).rejects.toThrow("simulated failure");
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
    );
    let fail = failDownload;
    const commands: string[] = [];
    Object.defineProperty(installer, "run", {
      value: async (_program: string, args: string[]) => {
        const command = args.join(" ");
        commands.push(command);
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
    );
    const commands: string[] = [];
    Object.defineProperty(installer, "run", {
      value: async (_: string, args: string[]) => {
        const command = args.join(" ");
        commands.push(command);
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
