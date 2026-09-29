import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ProfileFile = "settings.json" | "history.json";
type Snapshot = {
  owner: "delulu-profile-migration";
  version: 1;
  createdAt: number;
  files: Partial<Record<ProfileFile, string>>;
};
const owner = "delulu-profile-migration";
const snapshotName = /^migration-\d+-[0-9a-f-]{36}$/;
const pendingName = /^\.pending-\d+-[0-9a-f-]{36}$/;
const files: ProfileFile[] = ["settings.json", "history.json"];
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function completedSnapshots(root: string, includePending = false): Array<{ directory: string; manifest: Snapshot }> {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || (!snapshotName.test(entry.name) &&
        !(includePending && pendingName.test(entry.name)))) return [];
    const directory = join(root, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as Snapshot;
      if (manifest.owner !== owner || manifest.version !== 1 ||
          !Number.isFinite(manifest.createdAt) || !manifest.files ||
          Object.keys(manifest.files).some((name) => !files.includes(name as ProfileFile))) return [];
      return [{ directory, manifest }];
    } catch { return []; }
  });
}

/** Raw backups complete before migration writes; callers have already validated inputs. */
export function backupProfileMigration(
  dataDirectory: string,
  sources: Partial<Record<ProfileFile, string>>,
): void {
  const contents = files.flatMap((name) => {
    const path = sources[name];
    return path && existsSync(path) ? [{ name, bytes: readFileSync(path) }] : [];
  });
  if (!contents.length) return;
  const root = join(dataDirectory, "migration-backups");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const expected = Object.fromEntries(contents.map(({ name, bytes }) => [name, hash(bytes)]));
  let completed = completedSnapshots(root);
  // Verify reusable bytes, not merely a matching manifest, before skipping a backup.
  let keep = completed.find(({ directory, manifest }) => {
    if (Object.keys(manifest.files).length !== contents.length) return false;
    return contents.every(({ name }) => {
      if (manifest.files[name] !== expected[name]) return false;
      try { return hash(readFileSync(join(directory, name))) === expected[name]; }
      catch { return false; }
    });
  })?.directory;
  if (!keep) {
    const id = `${Date.now()}-${randomUUID()}`;
    const pending = join(root, `.pending-${id}`);
    const destination = join(root, `migration-${id}`);
    mkdirSync(pending, { mode: 0o700 });
    try {
      // Ownership metadata precedes copied history, so explicit deletion can
      // revoke history from an interrupted pending snapshot as well.
      const manifest: Snapshot = { owner, version: 1, createdAt: Date.now(), files: expected };
      writeFileSync(join(pending, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      for (const { name, bytes } of contents)
        writeFileSync(join(pending, name), bytes, { mode: 0o600, flag: "wx" });
      renameSync(pending, destination);
      keep = destination;
    } catch (error) {
      try { rmSync(pending, { recursive: true, force: true }); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Migration backup failed and its partial snapshot could not be removed", { cause: error });
      }
      throw new Error("Could not preserve a backup before profile migration; existing profile files were not replaced", { cause: error });
    }
    completed = completedSnapshots(root);
  }
  // Always retain the current source snapshot, even if the system clock moved.
  const old = completed.filter(({ directory }) => directory !== keep)
    .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt);
  for (const { directory } of old.slice(4))
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Explicit history deletion also revokes historical backup copies of that content. */
export function removeMigrationHistoryBackups(dataDirectory: string): void {
  const root = join(dataDirectory, "migration-backups");
  if (!existsSync(root)) return;
  for (const { directory, manifest } of completedSnapshots(root, true)) {
    if (!("history.json" in manifest.files)) continue;
    rmSync(join(directory, "history.json"), { force: true, maxRetries: 3, retryDelay: 100 });
    const remaining = { ...manifest.files };
    delete remaining["history.json"];
    if (!Object.keys(remaining).length) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      continue;
    }
    const temporary = join(directory, `manifest-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...manifest, files: remaining }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, join(directory, "manifest.json"));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
