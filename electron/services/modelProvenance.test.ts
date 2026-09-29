import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MODELS } from "../../src/data";

function pythonConstant(file: string, name: string) {
  const source = readFileSync(
    new URL(`../python/${file}`, import.meta.url),
    "utf8",
  );
  const value = source.match(new RegExp(`^${name} = "([^"]+)"`, "m"))?.[1];
  if (!value) throw new Error(`Missing backend provenance constant ${name}`);
  return value;
}

test("displayed pinned speech provenance matches the actual adapter downloads", () => {
  const windows = MODELS.find((model) => model.id === "r2t2")!;
  const mlx = MODELS.find((model) => model.id === "r2t2Mlx")!;
  expect(windows.hfId).toBe(pythonConstant("windows_speech.py", "MODEL"));
  expect(
    windows.provenance.variants.find(
      (variant) => variant.label === "Windows CUDA",
    )?.revision,
  ).toBe(pythonConstant("windows_speech.py", "MODEL_REVISION"));
  expect(
    windows.provenance.variants.find(
      (variant) => variant.label === "Windows CUDA",
    )?.conversion,
  ).toContain(pythonConstant("windows_speech.py", "CONVERSION_VERSION"));
  expect(mlx.hfId).toBe(pythonConstant("metal_speech.py", "MODEL"));
  expect(mlx.provenance.variants[0].revision).toBe(
    pythonConstant("metal_speech.py", "MODEL_REVISION"),
  );
});
