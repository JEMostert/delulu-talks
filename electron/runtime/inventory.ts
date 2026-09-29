import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimeArtifact } from "./artifacts";

/** Enumerates distribution metadata, without importing installed packages. */
export const PYTHON_INVENTORY_PROBE = `import importlib.metadata as metadata
import json
import platform
import struct
import sys

distributions = []
for distribution in metadata.distributions():
    name = distribution.metadata.get("Name")
    version = distribution.version
    if not name or not version:
        raise ValueError("Installed distribution has missing Name or Version metadata")
    distributions.append({"name": name, "version": version})
distributions.sort(key=lambda item: (item["name"].lower(), item["version"]))
print(json.dumps({
    "interpreter": {
        "executable": sys.executable,
        "version": platform.python_version(),
        "fullVersion": sys.version,
        "implementation": platform.python_implementation(),
        "prefix": sys.prefix,
        "basePrefix": sys.base_prefix,
        "platform": sys.platform,
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "pointerBits": struct.calcsize("P") * 8,
    },
    "distributions": distributions,
    "distributionCount": len(distributions),
}))
`;

export type RuntimeKind = "speech" | "magic";
export type TargetPlatform = { platform: string; arch: string };
export type InventoryBackend = {
  engine: "mlx-audio" | "qwen-asr-vllm" | "transformers";
  // Selection policy, not an observed GPU capability or inference result.
  devicePreference: ("metal" | "cuda" | "mps" | "cpu")[];
};
export type RequestedInstallStage = {
  name: "installer" | "windows-cuda" | "runtime";
  requirements: string[];
  pipArguments: string[];
  constraint: { path: string; contents: string } | null;
  artifacts?: RuntimeArtifact[];
  resolverArguments?: string[];
  artifactRequirements?: string;
};
type Interpreter = {
  executable: string;
  version: string;
  fullVersion: string;
  implementation: string;
  prefix: string;
  basePrefix: string;
  platform: string;
  system: string;
  release: string;
  machine: string;
  pointerBits: number;
};
type Distribution = { name: string; version: string };
export type RuntimeInventory = {
  schemaVersion: 1;
  createdAt: string;
  runtime: {
    revision: string;
    kind: RuntimeKind;
    generation: string;
    backend: InventoryBackend;
    target: TargetPlatform;
  };
  requested: RequestedInstallStage[];
  observed: {
    interpreter: Interpreter;
    distributionCount: number;
    distributions: Distribution[];
  };
};

export function inventoryBackend(
  kind: RuntimeKind,
  metal: boolean,
  windows: boolean,
): InventoryBackend {
  if (kind === "magic")
    return { engine: "transformers", devicePreference: ["cuda", "mps", "cpu"] };
  return metal
    ? { engine: "mlx-audio", devicePreference: ["metal"] }
    : {
        engine: windows ? "transformers" : "qwen-asr-vllm",
        devicePreference: ["cuda"],
      };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject incomplete/invalid observations before the activation pointer changes. */
export function createRuntimeInventory(
  context: {
    revision: string;
    kind: RuntimeKind;
    generation: string;
    backend: InventoryBackend;
    target: TargetPlatform;
    python: string;
    directory: string;
    requested: RequestedInstallStage[];
  },
  output: string,
): RuntimeInventory {
  try {
    const observed: unknown = JSON.parse(output);
    if (!record(observed) || !record(observed.interpreter))
      throw new Error("missing interpreter metadata");
    const interpreter = observed.interpreter;
    for (const field of [
      "executable",
      "version",
      "fullVersion",
      "implementation",
      "prefix",
      "basePrefix",
      "platform",
      "system",
      "release",
      "machine",
    ]) {
      if (typeof interpreter[field] !== "string" || !interpreter[field].trim())
        throw new Error(`missing interpreter ${field}`);
    }
    if (
      !/^\d+\.\d+\.\d+/.test(interpreter.version as string) ||
      ![32, 64].includes(interpreter.pointerBits as number)
    )
      throw new Error("invalid interpreter version or pointer size");
    if (
      resolve(interpreter.executable as string) !== resolve(context.python) ||
      resolve(interpreter.prefix as string) !== resolve(context.directory) ||
      resolve(interpreter.basePrefix as string) === resolve(context.directory)
    )
      throw new Error("metadata did not come from the candidate virtualenv");
    if (
      !Array.isArray(observed.distributions) ||
      observed.distributions.length === 0 ||
      observed.distributionCount !== observed.distributions.length
    )
      throw new Error("missing or incomplete installed distributions");
    const names = new Set<string>();
    const distributions: Distribution[] = observed.distributions.map(
      (distribution: unknown) => {
        if (
          !record(distribution) ||
          typeof distribution.name !== "string" ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(
            distribution.name,
          ) ||
          typeof distribution.version !== "string" ||
          !distribution.version.trim() ||
          /[\r\n\0]/.test(distribution.version)
        )
          throw new Error("invalid installed distribution metadata");
        const name = distribution.name.toLowerCase().replace(/[-_.]+/g, "-");
        if (names.has(name))
          throw new Error(`duplicate installed distribution: ${name}`);
        names.add(name);
        return { name: distribution.name, version: distribution.version };
      },
    );
    return {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      runtime: {
        revision: context.revision,
        kind: context.kind,
        generation: context.generation,
        backend: context.backend,
        target: context.target,
      },
      requested: context.requested,
      observed: {
        interpreter: interpreter as Interpreter,
        distributions,
        distributionCount: distributions.length,
      },
    };
  } catch (error) {
    throw new Error(
      `Could not validate runtime dependency inventory: ${error instanceof Error ? error.message : String(error)}. The previous environment is unchanged.`,
    );
  }
}

/** A partial report never becomes the generation's inventory. */
export function writeRuntimeInventory(
  directory: string,
  inventory: RuntimeInventory,
): void {
  const destination = join(
    directory,
    `runtime-${inventory.runtime.kind}-inventory.json`,
  );
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(inventory, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, destination);
  } catch (error) {
    throw new Error(
      `Could not write runtime dependency inventory: ${error instanceof Error ? error.message : String(error)}. The previous environment is unchanged.`,
    );
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Already renamed, or no temporary file was created. */
    }
  }
}
