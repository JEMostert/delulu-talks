import { stat, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SetupDiskCapacity, SetupSpaceSnapshot } from "../../src/types";
import type { StorageService } from "../services/storage";
import { magicModelById, modelById } from "../../src/data";
import { speechModelForPlatform } from "./platform";

/** Query the target filesystem, never enumerate runtime, cache or history files. */
async function queryCapacity(label: string, requestedPath: string): Promise<SetupDiskCapacity> {
  let current = resolve(requestedPath);
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      const info = await stat(current, { bigint: true });
      if (!info.isDirectory()) throw new Error("Destination ancestor is not a directory");
      const filesystem = await statfs(current, { bigint: true });
      const available = filesystem.bavail * filesystem.bsize;
      if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Capacity outside supported range");
      return { label, requestedPath, queriedPath: current, availableBytes: Number(available), filesystem: info.dev.toString(), status: "observed", detail: current === resolve(requestedPath) ? "Current filesystem capacity available to this process, not a reservation." : "Destination does not exist yet; capacity is from its nearest existing ancestor. Future mounts or path changes may differ." };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { label, requestedPath, queriedPath: current, availableBytes: null, filesystem: null, status: "unknown", detail: "Could not read filesystem capacity. Check the destination and permissions; no directory was created." };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return { label, requestedPath, queriedPath: null, availableBytes: null, filesystem: null, status: "unknown", detail: "No accessible existing destination ancestor found within the bounded query." };
}

function capacity(label: string, requestedPath: string): Promise<SetupDiskCapacity> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<SetupDiskCapacity>((resolve) => {
    timer = setTimeout(() => resolve({ label, requestedPath, queriedPath: null, availableBytes: null, filesystem: null, status: "unknown", detail: "Filesystem query timed out. Refresh after checking the destination; capacity was not assumed." }), 2500);
  });
  return Promise.race([queryCapacity(label, requestedPath), timeout]).finally(() => clearTimeout(timer));
}

function pipCacheDirectory(): string {
  if (process.env.PIP_CACHE_DIR) return process.env.PIP_CACHE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pip", "Cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "pip");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pip");
}

export async function setupSpaceSnapshot(storage: StorageService): Promise<SetupSpaceSnapshot> {
  const speechId = speechModelForPlatform();
  const speechModel = modelById(speechId);
  const magicModel = magicModelById(storage.getSettings().magicModel);
  // Speech estimates are the existing model catalogue, not remote manifests.
  const speechBytes = speechId === "r2t2Mlx" ? 4.1e9 : 4e9;
  // Marketing parameter count × two-byte BF16 weights is a planning estimate,
  // not a measured checkpoint size or a claim about RAM consumption.
  const parameters = { qwen35Small: 0.8e9, qwen35Medium: 2e9, qwen35Large: 4e9 }[magicModel.id];
  const magicBytes = parameters * 2;
  const convertedBytes = process.platform === "win32" ? speechBytes : 0;
  const disk = await Promise.all([
    capacity("Speech runtime generations", storage.venvDirectory),
    capacity("Rewrite runtime generations", storage.magicVenvDirectory),
    capacity("Model cache", storage.modelCacheDirectory),
    capacity("System temporary files", tmpdir()),
    capacity("Expected pip download cache", pipCacheDirectory()),
  ]);
  return {
    magicModel: magicModel.id,
    checkedAt: Date.now(),
    disk,
    plans: [
      { kind: "speech", modelName: speechModel.name, modelDownloadBytes: speechBytes, modelInstalledBytes: speechBytes + convertedBytes, modelTemporaryBytes: speechBytes, basis: `Approximate checkpoint download from the app catalogue (${speechModel.downloadSize}). Installed estimate retains that checkpoint${convertedBytes ? " plus one similarly sized Windows converted copy" : ""}. Staging allowance is one additional checkpoint. Ancillary files and other cached revisions are excluded.` },
      { kind: "magic", modelName: magicModel.name, modelDownloadBytes: magicBytes, modelInstalledBytes: magicBytes, modelTemporaryBytes: magicBytes, basis: `Weights-only planning estimate: ${magicModel.parameters} parameters × 2 bytes (BF16). Complete repository size is unknown; tokenizer, vision/config overhead, other dtypes and additional revisions can increase it. Staging allowance is one additional weights copy. This is a disk estimate, not the RAM estimate shown for this model.` },
    ],
    runtimeDownload: "Unknown until platform wheels and transitive dependencies are resolved; no package downloads or resolution were started.",
    runtimeInstalled: "Unknown. A full new isolated runtime generation is installed; manifest version pins contain no resolved disk-size metadata.",
    runtimeTemporary: "Unknown. Repair retains the previous runtime and creates one full additional generation. Wheel cache, unpacking and build scratch space need additional capacity in their respective destinations.",
    caveat: "Estimates use decimal GB, assume no reusable cached checkpoint, and do not subtract existing caches. Previous generations, other models, old revisions, package caches and concurrent disk use remain on disk. No complete setup/repair total or sufficient-space guarantee is available.",
  };
}
