import { expect, test } from "bun:test";
import { speechModelForPlatform } from "./platform";

test("only native Apple Silicon selects the MLX engine", () => {
  expect(speechModelForPlatform("darwin", "arm64")).toBe("qwen3Asr");
  expect(speechModelForPlatform("darwin", "x64")).toBe("r2t2");
  expect(speechModelForPlatform("linux", "x64")).toBe("r2t2");
  expect(speechModelForPlatform("win32", "x64")).toBe("r2t2");
});
