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
import { runtimePython } from "./location";
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
