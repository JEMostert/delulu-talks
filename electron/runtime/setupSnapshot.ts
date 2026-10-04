import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeSetupSnapshot,
  SetupRuntimeObservation,
} from "../../src/types";
import type { StorageService } from "../services/storage";
import { runtimeDirectory, runtimePython } from "./location";
import { RUNTIME_REVISION } from "./manifest";
import { inventoryBackend } from "./inventory";
import { setupSpaceSnapshot } from "./setupSpace";
import { usesMetal } from "./platform";

// -S skips site/sitecustomize; only standard-library modules execute. Discovering
// top-level specs does not import torch, MLX, transformers or their dependencies.
const PROBE = `import sys,json,os,importlib.util
root=os.path.dirname(os.path.dirname(sys.executable))
version='python%d.%d' % sys.version_info[:2]
for path in [os.path.join(root,'Lib','site-packages'),os.path.join(root,'lib',version,'site-packages'),os.path.join(root,'lib64',version,'site-packages')]:
    if os.path.isdir(path): sys.path.append(path)
modules={}
for name in sys.argv[1:]:
    try:
        spec=importlib.util.find_spec(name)
        modules[name]={'status':'located' if spec else 'missing','location':str(spec.origin or 'namespace package') if spec else None}
    except Exception:
        modules[name]={'status':'unknown','location':None}
print(json.dumps({'executable':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),'machine':os.uname().machine if hasattr(os,'uname') else os.environ.get('PROCESSOR_ARCHITECTURE','unknown'),'modules':modules}))`;

function inspect(
  program: string,
  selector: string[],
  modules: string[],
): Promise<SetupRuntimeObservation["interpreter"]> {
  return new Promise((resolve) => {
    execFile(
      program,
      [...selector, "-I", "-B", "-S", "-c", PROBE, ...modules],
      {
        timeout: 2500,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve({
            command: [program, ...selector].join(" "),
            status:
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "missing"
                : "unknown",
            executable: null,
            version: null,
            machine: null,
            modules: [],
            detail:
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "Interpreter not found. Configure its full path in Settings → Advanced."
                : "Interpreter probe failed or timed out. Check the configured path and permissions; no package imports were attempted.",
          });
          return;
        }
        try {
          const value = JSON.parse(stdout);
          if (
            typeof value.executable !== "string" ||
            typeof value.version !== "string" ||
            typeof value.machine !== "string" ||
            !value.modules ||
            typeof value.modules !== "object"
          )
            throw new Error("Malformed probe");
          const observations = modules.map((name) => {
            const item = value.modules[name];
            if (
              !item ||
              !["located", "missing", "unknown"].includes(item.status) ||
              !(item.location === null || typeof item.location === "string")
            )
              throw new Error("Malformed module result");
            return {
              name,
              status: item.status as "located" | "missing" | "unknown",
              location: item.location,
            };
          });
          resolve({
            command: [program, ...selector].join(" "),
            status: "observed",
            executable: value.executable,
            version: value.version,
            machine: value.machine,
            modules: observations,
            detail:
              "Current isolated interpreter and module discovery. Located modules have not been imported.",
          });
        } catch {
          resolve({
            command: program,
            status: "unknown",
            executable: null,
            version: null,
            machine: null,
            modules: [],
            detail:
              "Interpreter returned an unreadable probe result. Check Settings → Advanced.",
          });
        }
      },
    );
  });
}

function candidates(command: string, metal: boolean): string[][] {
  const parts = (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(
    (part) => part.replace(/^(["'])(.*)\1$/, "$2"),
  );
  // Accept executable paths and the Windows Python launcher selector, never a
  // configured script, -c command or arbitrary flags in this read-only probe.
  if (
    !parts.length ||
    parts.length > 2 ||
    (parts.length === 2 &&
      !(process.platform === "win32" && /^-3\.\d+$/.test(parts[1])))
  )
    return [];
  if (!["python", "python3"].includes(parts[0])) return [parts];
  const fallbacks = metal
    ? [
        ["python3.12"],
        ["/opt/homebrew/bin/python3.12"],
        [join(homedir(), ".local/bin/python3.12")],
      ]
    : process.platform === "win32"
      ? [["py", "-3.12"], ["python3.12"]]
      : [["python3.13"], ["python3.12"], ["python3.11"]];
  return [...fallbacks, parts];
}

function compatible(
  interpreter: SetupRuntimeObservation["interpreter"],
  metal: boolean,
): boolean {
  const [major, minor] = (interpreter.version ?? "").split(".").map(Number);
  return (
    interpreter.status === "observed" &&
    major === 3 &&
    (metal || process.platform === "win32"
      ? minor === 12
      : minor >= 11 && minor <= 13) &&
    (!metal || interpreter.machine === "arm64")
  );
}

async function runtime(
  storage: StorageService,
  kind: "speech" | "magic",
): Promise<SetupRuntimeObservation> {
  const metal = kind === "speech" && usesMetal();
  const root =
    kind === "speech" ? storage.venvDirectory : storage.magicVenvDirectory;
  const backend = inventoryBackend(kind, metal, process.platform === "win32");
  const modules =
    kind === "magic"
      ? ["torch", "torchvision", "transformers"]
      : metal
        ? ["mlx", "mlx_audio"]
        : ["torch", "transformers", "soundfile", "soxr"];
  const result: SetupRuntimeObservation = {
    kind,
    root,
    directory: null,
    runtimeState: "missing",
    expectedRevision: RUNTIME_REVISION,
    backend: backend.engine,
    devicePreference: backend.devicePreference.join(" → "),
    deviceObservation:
      "Not probed. Device preference is selection policy, not proof of GPU availability.",
    interpreter: {
      command: storage.getSettings().pythonCommand,
      status: "unknown",
      executable: null,
      version: null,
      machine: null,
      modules: [],
      detail: "Not observed.",
    },
    bootstrap: [],
    importProbe:
      "Not run. Module discovery cannot establish successful imports or native readiness.",
    cachedInventory: {
      status: "missing",
      createdAt: null,
      revision: null,
      interpreter: null,
      detail:
        "No installer inventory. Setup records one after its readiness probe; no historical import result is available.",
    },
  };
  try {
    const directory = runtimeDirectory(root);
    result.directory = directory;
    const python = runtimePython(root);
    result.runtimeState = existsSync(python) ? "present" : "missing";
    result.interpreter.command = python;
    if (result.runtimeState === "missing") {
      result.interpreter.status = "missing";
      result.interpreter.detail =
        "Dedicated runtime interpreter not found. Setup can create it using a compatible candidate below.";
    }
    if (result.runtimeState === "present") {
      result.interpreter = await inspect(python, [], modules);
      if (
        result.interpreter.status === "observed" &&
        !compatible(result.interpreter, metal)
      ) {
        result.interpreter.status = "unsupported";
        result.interpreter.detail =
          "Interpreter version/architecture is unsupported. Repair the dedicated runtime with a compatible Python in Settings → Advanced.";
      }
    }
    const inventoryPath = join(directory, `runtime-${kind}-inventory.json`);
    if (existsSync(inventoryPath)) {
      try {
        if (statSync(inventoryPath).size > 2 * 1024 * 1024)
          throw new Error("Oversized inventory");
        const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
        if (
          inventory.schemaVersion !== 1 ||
          inventory.runtime?.kind !== kind ||
          typeof inventory.runtime.revision !== "string" ||
          typeof inventory.createdAt !== "string" ||
          typeof inventory.observed?.interpreter?.version !== "string"
        )
          throw new Error("Invalid inventory");
        result.cachedInventory = {
          status: "cached",
          createdAt: inventory.createdAt,
          revision: inventory.runtime.revision,
          interpreter: inventory.observed.interpreter.version,
          detail:
            "Historical installer inventory, written after setup's successful readiness stage. It does not prove imports or hardware work now.",
        };
      } catch {
        result.cachedInventory = {
          status: "unreadable",
          createdAt: null,
          revision: null,
          interpreter: null,
          detail:
            "Installer inventory is unreadable or invalid. Repair can create a new inventory; existing files were not changed.",
        };
      }
    }
  } catch {
    result.runtimeState = "unknown";
    result.interpreter.detail =
      "Runtime activation record is unreadable or invalid. Use Repair to rebuild safely; no files were changed.";
  }
  const options = candidates(storage.getSettings().pythonCommand, metal);
  result.bootstrap = await Promise.all(
    options.map(([program, ...selector]) => inspect(program, selector, [])),
  );
  for (const item of result.bootstrap) {
    if (item.status === "observed" && !compatible(item, metal)) {
      item.status = "unsupported";
      item.detail = metal
        ? "Requires native arm64 Python 3.12."
        : process.platform === "win32"
          ? "Requires Python 3.12."
          : "Requires Python 3.11–3.13.";
    }
  }
  if (!options.length)
    result.interpreter.detail +=
      " Configured command contains unsupported arguments; use an interpreter path (or Windows py -3.12).";
  return result;
}

const pending = new WeakMap<
  StorageService,
  { key: string; promise: Promise<RuntimeSetupSnapshot> }
>();

export function runtimeSetupSnapshot(
  storage: StorageService,
): Promise<RuntimeSetupSnapshot> {
  const settings = storage.getSettings();
  const key = JSON.stringify([settings.pythonCommand, settings.magicModel]);
  const existing = pending.get(storage);
  if (existing?.key === key) return existing.promise;
  const snapshot = Promise.all([
    runtime(storage, "speech"),
    runtime(storage, "magic"),
    setupSpaceSnapshot(storage),
  ])
    .then(([speech, magic, space]): RuntimeSetupSnapshot => ({
      checkedAt: Date.now(),
      platform: process.platform,
      arch: process.arch,
      source: "desktop",
      runtimes: [speech, magic],
      space,
    }))
    .finally(() => {
      if (pending.get(storage)?.promise === snapshot) pending.delete(storage);
    });
  pending.set(storage, { key, promise: snapshot });
  return snapshot;
}
