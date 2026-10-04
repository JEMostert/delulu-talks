import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}

export function runtimeDirectory(root: string): string {
  const pointer = join(root, "active.json");
  if (!existsSync(pointer)) return root; // Pre-generation installations remain usable.
  const { generation } = JSON.parse(readFileSync(pointer, "utf8"));
  if (!validGeneration(generation))
    throw new Error(
      "Invalid runtime activation record. Run Repair to rebuild safely.",
    );
  return join(root, "generations", generation);
}

export function runtimePython(root: string): string {
  return join(
    runtimeDirectory(root),
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
}

/** Switch only the pointer: moving a venv would break its absolute script paths. */
export function activateRuntime(root: string, generation: string): void {
  if (!validGeneration(generation))
    throw new Error(
      "Invalid runtime generation; existing activation was preserved",
    );
  let previous: string | null = null;
  try {
    previous = JSON.parse(
      readFileSync(join(root, "active.json"), "utf8"),
    ).generation;
  } catch {
    /* Legacy or damaged pointer. */
  }
  const temporary = join(root, `active-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ generation, previous }), {
      mode: 0o600,
    });
    renameSync(temporary, join(root, "active.json"));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the activation error. */
    }
    throw error;
  }
}

export function rollbackRuntime(root: string): void {
  const pointer = join(root, "active.json");
  const { previous } = JSON.parse(readFileSync(pointer, "utf8"));
  if (previous === null) {
    unlinkSync(pointer);
    return;
  }
  if (!validGeneration(previous))
    throw new Error("Invalid previous runtime activation record");
  activateRuntime(root, previous);
}
