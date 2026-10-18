import { randomUUID } from "node:crypto";
import {
  lstatSync,
  opendirSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  ModelCacheCleanupResult,
  ModelCacheEntry,
  ModelCachePreview,
  SpeechDownload,
  SpeechDownloadId,
} from "../../src/types";

const VERIFIED = "hub/delulu-verified";
/** Where each speech checkpoint lives in the model cache, relative to its root. */
const SPEECH_DOWNLOADS: {
  id: SpeechDownloadId;
  name: string;
  paths: string[];
}[] = [
  {
    id: "canary-180m",
    name: "Small · Canary 180M",
    paths: [
      `${VERIFIED}/csukuangfj--sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8`,
    ],
  },
  {
    id: "parakeet-v2",
    name: "Medium · Parakeet v2 (English)",
    paths: [
      `${VERIFIED}/csukuangfj--sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`,
    ],
  },
  {
    id: "parakeet-v3",
    name: "Medium · Parakeet v3 (Automatic)",
    paths: [
      `${VERIFIED}/csukuangfj--sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`,
    ],
  },
  {
    id: "r2t2",
    name: "Large · R2T2",
    paths: [
      `${VERIFIED}/netease-youdao--Confucius4-R2T2`,
      `${VERIFIED}/mlx-community--Confucius4-R2T2-bf16`,
      "hub/models--netease-youdao--Confucius4-R2T2",
      "hub/models--mlx-community--Confucius4-R2T2-bf16",
      "delulu-r2t2-transformers",
    ],
  },
];

const PLAN_LIFETIME_MS = 10 * 60 * 1000;
const MAX_SIZE_NODES = 20_000;
const MAX_SIZE_DEPTH = 64;
const MAX_PREVIEW_CHILDREN = 2_000;

type TraversalBudget = { remaining: number };

type PlannedEntry = { path: string; snapshot: BigIntStats };
type CleanupPlan = {
  token: string;
  expiresAt: number;
  root: BigIntStats | null;
  hub: BigIntStats | null;
  entries: Map<string, PlannedEntry>;
};

function optionalStat(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw reason;
  }
}

function safeDirectory(path: string): BigIntStats | null {
  const stat = optionalStat(path);
  if (
    stat &&
    (!stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(path) !== path)
  )
    throw new Error(
      "The model cache location is not a local directory. No cache was deleted.",
    );
  return stat;
}

function unchanged(
  before: BigIntStats | null,
  after: BigIntStats | null,
): boolean {
  if (!before || !after) return before === after;
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.mode === after.mode
  );
}

function directoryNames(path: string, budget: TraversalBudget): string[] {
  const names: string[] = [];
  const directory = opendirSync(path);
  try {
    while (true) {
      const child = directory.readSync();
      if (!child) break;
      if (budget.remaining <= 0)
        throw new Error(
          "The model cache contains too many entries to preview safely. No cache was deleted.",
        );
      budget.remaining--;
      names.push(child.name);
    }
  } finally {
    directory.closeSync();
  }
  return names;
}

/** Counts link bytes without visiting targets, using one shared preview budget. */
function sizeOf(
  path: string,
  budget: TraversalBudget,
): { bytes: number; sizeComplete: boolean } {
  let bytes = 0;
  let sizeComplete = true;
  const visit = (current: string, depth: number) => {
    if (budget.remaining <= 0) {
      sizeComplete = false;
      return;
    }
    budget.remaining--;
    if (depth > MAX_SIZE_DEPTH) {
      sizeComplete = false;
      return;
    }
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        bytes += stat.size;
        return;
      }
      const directory = opendirSync(current);
      try {
        while (true) {
          if (budget.remaining <= 0) {
            sizeComplete = false;
            break;
          }
          const child = directory.readSync();
          if (!child) break;
          visit(join(current, child.name), depth + 1);
        }
      } finally {
        directory.closeSync();
      }
    } catch {
      sizeComplete = false;
    }
  };
  visit(path, 0);
  if (!Number.isSafeInteger(bytes)) sizeComplete = false;
  return { bytes, sizeComplete };
}

export class ModelCacheService {
  private readonly root: string;
  private plan: CleanupPlan | undefined;

  constructor(cacheRoot: string) {
    this.root = resolve(cacheRoot);
  }

  /** Speech checkpoints present in the cache, with their size on disk. */
  speechDownloads(): SpeechDownload[] {
    if (!safeDirectory(this.root)) return [];
    const budget = { remaining: MAX_SIZE_NODES };
    return SPEECH_DOWNLOADS.flatMap(({ id, name, paths }) => {
      const present = paths
        .map((path) => join(this.root, path))
        .filter((path) => optionalStat(path));
      if (!present.length) return [];
      const bytes = present.reduce(
        (sum, path) => sum + sizeOf(path, budget).bytes,
        0,
      );
      return [{ id, name, bytes }];
    });
  }

  /** Delete one speech checkpoint; it downloads again the next time it loads. */
  deleteSpeechDownload(id: string): SpeechDownload[] {
    const download = SPEECH_DOWNLOADS.find((item) => item.id === id);
    if (!download) throw new Error("Unknown speech model");
    if (!safeDirectory(this.root)) return [];
    this.plan = undefined;
    for (const relative of download.paths) {
      const path = join(this.root, relative);
      // Never follow a link out of the cache.
      const stat = optionalStat(path);
      if (stat?.isSymbolicLink()) continue;
      rmSync(path, { recursive: true, force: true });
      rmSync(`${path}.lock`, { force: true });
    }
    return this.speechDownloads();
  }

  preview(): ModelCachePreview {
    this.plan = undefined;
    const root = safeDirectory(this.root);
    const hubPath = join(this.root, "hub");
    const hub = root ? safeDirectory(hubPath) : null;
    const entries: ModelCacheEntry[] = [];
    const planned = new Map<string, PlannedEntry>();
    const sizeBudget = { remaining: MAX_SIZE_NODES };
    const listingBudget = { remaining: MAX_PREVIEW_CHILDREN };
    const add = (id: string, path: string, label: string) => {
      const snapshot = lstatSync(path, { bigint: true });
      if (
        snapshot.isSymbolicLink() ||
        (!snapshot.isFile() && !snapshot.isDirectory())
      )
        return;
      if (realpathSync(path) !== path) return;
      const size = sizeOf(path, sizeBudget);
      planned.set(id, { path, snapshot });
      entries.push({ id, label, ...size });
    };
    if (root) {
      for (const name of directoryNames(this.root, listingBudget)) {
        if (name !== "hub") add(name, join(this.root, name), name);
      }
    }
    if (hub) {
      for (const name of directoryNames(hubPath, listingBudget)) {
        if (!name.startsWith("models--")) continue;
        const path = join(hubPath, name);
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        add(
          `hub/${name}`,
          path,
          name.slice("models--".length).split("--").join("/"),
        );
      }
    }
    // Enumeration is read-only; reject a changing location rather than approve
    // a preview assembled across different directory identities.
    if (
      !unchanged(root, safeDirectory(this.root)) ||
      !unchanged(hub, root ? safeDirectory(hubPath) : null)
    )
      throw new Error(
        "The model cache changed during preview. Refresh the preview.",
      );
    const token = randomUUID();
    this.plan = {
      token,
      expiresAt: Date.now() + PLAN_LIFETIME_MS,
      root,
      hub,
      entries: planned,
    };
    return { token, entries };
  }

  cleanup(token: string, ids: string[]): ModelCacheCleanupResult {
    const selected = [...new Set(ids)];
    const result: ModelCacheCleanupResult = { deletedIds: [], failures: [] };
    const reject = (message: string) => {
      result.failures = selected.map((id) => ({ id, message }));
      return result;
    };
    const plan = this.plan;
    if (!plan || plan.token !== token)
      return reject(
        "This cache preview is no longer current. Refresh before deleting.",
      );
    this.plan = undefined;
    if (Date.now() >= plan.expiresAt)
      return reject("This cache preview expired. Refresh before deleting.");
    try {
      if (
        !unchanged(plan.root, safeDirectory(this.root)) ||
        !unchanged(
          plan.hub,
          plan.root ? safeDirectory(join(this.root, "hub")) : null,
        )
      )
        throw new Error("The model cache changed. Refresh before deleting.");
      // Validate every selection before any destructive operation. Renderer IDs
      // only look up private planned paths; they never become filesystem paths.
      // Snapshots cover directory/entry identity and stats, not a fingerprint of
      // nested content. External filesystem writers can still race path-based rm.
      for (const id of selected) {
        const entry = plan.entries.get(id);
        if (!entry)
          throw new Error(
            "A selected cache entry was not in this preview. Refresh before deleting.",
          );
        const current = lstatSync(entry.path, { bigint: true });
        if (
          current.isSymbolicLink() ||
          realpathSync(entry.path) !== entry.path ||
          !unchanged(entry.snapshot, current)
        )
          throw new Error(
            "A selected cache entry changed. Refresh before deleting.",
          );
      }
    } catch (reason) {
      return reject(
        reason instanceof Error
          ? reason.message
          : "The cache could not be validated. Refresh before deleting.",
      );
    }
    for (const id of selected) {
      const entry = plan.entries.get(id)!;
      try {
        rmSync(entry.path, { recursive: true, force: false });
        result.deletedIds.push(id);
      } catch (reason) {
        result.failures.push({
          id,
          message:
            reason instanceof Error
              ? reason.message
              : "This cache entry could not be deleted.",
        });
      }
    }
    return result;
  }
}
