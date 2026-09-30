import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// These are the legacy files created exclusively by DictationService, never an imported source path.
const GENERATED_AUDIO =
  /^(?:dictation|import)-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/;

export type AudioCacheRecovery = {
  removed: number;
  skipped: number;
  failureCount: number;
  failures: string[];
};

/** Run once after the primary-instance lock, before workers, capture or import can start. */
export async function recoverTemporaryAudio(
  cacheDirectory: string,
  startedAt = Date.now(),
): Promise<AudioCacheRecovery> {
  const report: AudioCacheRecovery = {
    removed: 0,
    skipped: 0,
    failureCount: 0,
    failures: [],
  };
  const fail = (name: string, error: unknown) => {
    report.failureCount++;
    if (report.failures.length < 20) {
      const detail = error instanceof Error ? error.message : String(error);
      report.failures.push(`${name}: ${detail.slice(0, 500)}`);
    }
  };
  let names: string[];
  try {
    const directory = await lstat(cacheDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      fail(
        "Audio cache",
        "Expected Delulu's own regular audio-cache directory; cleanup did not follow this path.",
      );
      return report;
    }
    names = await readdir(cacheDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      fail("Audio cache", error);
    return report;
  }
  for (const name of names) {
    const match = GENERATED_AUDIO.exec(name);
    if (!match || Number(match[1]) >= startedAt) {
      report.skipped++;
      continue;
    }
    const path = join(cacheDirectory, name);
    try {
      // lstat inspects the entry itself. Never recurse, follow links or touch source media.
      const file = await lstat(path);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        file.mtimeMs >= startedAt
      ) {
        report.skipped++;
        continue;
      }
      await unlink(path);
      report.removed++;
    } catch (error) {
      // Another cleanup may already have removed the entry; other failures remain visible.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(name, error);
    }
  }
  return report;
}
