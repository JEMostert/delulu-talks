import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateRuntime, runtimeDirectory } from "./location";
import { SerialQueue } from "./serialQueue";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "delulu-unit-runtime-"));
  directories.push(path);
  return path;
}
const old = "12345678-1234-1234-1234-123456789abc";
const candidate = "87654321-4321-4321-4321-cba987654321";

test("legacy installations stay usable and activation switches generations", () => {
  const root = directory();
  expect(runtimeDirectory(root)).toBe(root);
  activateRuntime(root, old);
  expect(runtimeDirectory(root)).toBe(join(root, "generations", old));
  activateRuntime(root, candidate);
  expect(runtimeDirectory(root)).toBe(join(root, "generations", candidate));
});

test("malformed activation cannot replace the working pointer", () => {
  const root = directory();
  activateRuntime(root, old);
  const pointer = join(root, "active.json");
  const original = readFileSync(pointer, "utf8");
  expect(() => activateRuntime(root, "../outside")).toThrow(
    "Invalid runtime generation",
  );
  expect(readFileSync(pointer, "utf8")).toBe(original);
  expect(readdirSync(root)).toEqual(["active.json"]);
});

test("model operations remain ordered after a rejection and release their busy state", async () => {
  const queue = new SerialQueue();
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failed = queue.run(async () => {
    calls.push("load");
    await gate;
    throw new Error("Load failed");
  });
  const rejection = failed.catch((error: Error) => error.message);
  const retry = queue.run(async () => {
    calls.push("retry");
    return "ready";
  });
  await Promise.resolve();
  expect(calls).toEqual(["load"]);
  expect(queue.busy).toBe(true);
  release();
  expect(await rejection).toBe("Load failed");
  expect(await retry).toBe("ready");
  expect(calls).toEqual(["load", "retry"]);
  expect(queue.busy).toBe(false);
});
