import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateRuntime, rollbackRuntime, runtimeDirectory } from "./location";
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

test("failed repair can restore the prior runtime or a legacy installation", () => {
  const root = directory();
  expect(runtimeDirectory(root)).toBe(root);
  activateRuntime(root, old);
  rollbackRuntime(root);
  expect(runtimeDirectory(root)).toBe(root);
  activateRuntime(root, old);
  activateRuntime(root, candidate);
  expect(runtimeDirectory(root)).toBe(join(root, "generations", candidate));
  rollbackRuntime(root);
  expect(runtimeDirectory(root)).toBe(join(root, "generations", old));
});

test("malformed activation and rollback targets cannot replace the working pointer", () => {
  const root = directory();
  activateRuntime(root, old);
  const pointer = join(root, "active.json");
  const original = readFileSync(pointer, "utf8");
  expect(() => activateRuntime(root, "../outside")).toThrow(
    "Invalid runtime generation",
  );
  expect(readFileSync(pointer, "utf8")).toBe(original);
  writeFileSync(
    pointer,
    JSON.stringify({ generation: old, previous: "../outside" }),
  );
  const damaged = readFileSync(pointer, "utf8");
  expect(() => rollbackRuntime(root)).toThrow("Invalid previous");
  expect(readFileSync(pointer, "utf8")).toBe(damaged);
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
