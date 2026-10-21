import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { pipCheckScript } from "./installer";
import { VOICE_PIP_CHECK_EXCEPTIONS } from "./manifest";
import { runtimeReadinessScript } from "./prerequisites";
import { voiceRuntimeProfile } from "./platform";

const python = ["python3", "python"].find(
  (command) => !spawnSync(command, ["--version"]).error,
);

function compiles(source: string): string {
  const result = spawnSync(
    python!,
    ["-c", "import sys; compile(sys.stdin.read(), '<runtime>', 'exec')"],
    { input: source, encoding: "utf8" },
  );
  return result.status === 0 ? "" : result.stderr;
}

test.skipIf(!python)("generated voice runtime scripts are valid Python", () => {
  expect(compiles(pipCheckScript(VOICE_PIP_CHECK_EXCEPTIONS))).toBe("");
  const target = { platform: "linux", arch: "x64" };
  for (const profile of ["cpu", "full"] as const)
    expect(
      compiles(runtimeReadinessScript("voice", target, true, profile)),
    ).toBe("");
});

test("the voice profile follows the selected engine", () => {
  expect(voiceRuntimeProfile("kokoro")).toBe("cpu");
  expect(voiceRuntimeProfile("chatterbox-turbo")).toBe("full");
  const target = { platform: "linux", arch: "x64" };
  const full = runtimeReadinessScript("voice", target, true, "full");
  expect(full).toContain("from chatterbox.tts_turbo import");
  // The voice runtime never requires a GPU or MLX, even on a Metal Mac.
  expect(full).not.toContain("torch.cuda.is_available");
  expect(full).not.toContain("mlx");
  expect(runtimeReadinessScript("voice", target, false, "cpu")).not.toContain(
    "torch",
  );
});
