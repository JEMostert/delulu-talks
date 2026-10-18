import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCacheService } from "./modelCache";

const verified = (root: string, repo: string) =>
  join(root, "hub", "delulu-verified", repo);

test("downloaded speech models are listed with their size and deleted one at a time", () => {
  const root = mkdtempSync(join(tmpdir(), "delulu-cache-"));
  const canary = verified(
    root,
    "csukuangfj--sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8",
  );
  const r2t2 = verified(root, "netease-youdao--Confucius4-R2T2");
  const converted = join(root, "delulu-r2t2-transformers", "v1");
  for (const directory of [canary, r2t2, converted])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(canary, "encoder.int8.onnx"), Buffer.alloc(1000));
  writeFileSync(`${canary}.lock`, "");
  writeFileSync(join(r2t2, "model.safetensors"), Buffer.alloc(3000));
  writeFileSync(join(converted, "model.safetensors"), Buffer.alloc(2000));
  const cache = new ModelCacheService(root);

  const listed = cache.speechDownloads();
  expect(listed.map((item) => item.id)).toEqual(["canary-180m", "r2t2"]);
  expect(
    listed.find((item) => item.id === "r2t2")!.bytes,
  ).toBeGreaterThanOrEqual(5000);

  // R2T2 includes its converted copy; Canary is untouched.
  expect(cache.deleteSpeechDownload("r2t2").map((item) => item.id)).toEqual([
    "canary-180m",
  ]);
  expect(existsSync(r2t2)).toBe(false);
  expect(existsSync(join(root, "delulu-r2t2-transformers"))).toBe(false);
  expect(existsSync(canary)).toBe(true);

  expect(cache.deleteSpeechDownload("canary-180m")).toEqual([]);
  expect(existsSync(`${canary}.lock`)).toBe(false);
  expect(() => cache.deleteSpeechDownload("../hub")).toThrow(
    "Unknown speech model",
  );
});
