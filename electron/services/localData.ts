import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LocalDataLocation, LocalDataOverview } from "../../src/types";

// Metadata only: never read transcript/settings content, follow links, or mutate data.
export async function inspectLocalDataLocation(
  path: string,
  fs: {
    lstat(path: string): Promise<Stats>;
    readdir(path: string): Promise<string[]>;
  } = { lstat, readdir },
): Promise<LocalDataLocation> {
  const result: LocalDataLocation = {
    path,
    status: "present",
    bytes: 0,
    files: 0,
    skippedLinks: 0,
    problems: [],
  };
  const pending = [path];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > 100_000) {
      result.status = "partial";
      result.problems.push("Scan limit reached; size is a lower bound.");
      break;
    }
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        result.skippedLinks += 1;
      } else if (stat.isDirectory()) {
        const names = await fs.readdir(current);
        const available = Math.max(0, 100_000 - visited - pending.length);
        for (let index = 0; index < Math.min(names.length, available); index++)
          pending.push(join(current, names[index]));
        if (names.length > available) {
          result.status = "partial";
          if (
            !result.problems.includes(
              "Scan limit reached; size is a lower bound.",
            )
          )
            result.problems.push("Scan limit reached; size is a lower bound.");
        }
      } else if (stat.isFile()) {
        result.bytes += stat.size;
        result.files += 1;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (current === path && code === "ENOENT") {
        result.status = "missing";
      } else {
        result.status = "partial";
        if (result.problems.length < 5)
          result.problems.push(`${current}: ${code}`);
      }
    }
  }
  return result;
}

export async function localDataOverview(storage: {
  dataDirectory: string;
}): Promise<LocalDataOverview> {
  const root = storage.dataDirectory;
  const definitions = [
    {
      id: "history" as const,
      label: "History",
      description:
        "Saved original transcripts, corrections and rewrites. Turning off history stops new saves; existing text remains.",
      paths: ["history.json", "history.json.tmp"],
    },
    {
      id: "settings" as const,
      label: "Settings",
      description:
        "Preferences, vocabulary, shortcuts and local permission tokens, including any interrupted settings write.",
      paths: ["settings.json", "settings.json.tmp"],
    },
    {
      id: "models" as const,
      label: "Model cache",
      description:
        "Downloaded R2T2 and optional Qwen 3.5 weights, download cache and converted checkpoints. Separate from Python runtimes.",
      paths: ["models"],
    },
    {
      id: "runtimes" as const,
      label: "Runtimes",
      description:
        "Speech, writing and preserved legacy Python environments. A legacy environment may still be used for writing; presence does not establish readiness.",
      paths: ["speech-venv", "magic-venv", "asr-venv"],
    },
    {
      id: "audio" as const,
      label: "Temporary audio",
      description:
        "Recording files, including failed recordings retained for retry. Imported source audio stays at its original location and is not counted here.",
      paths: ["audio-cache"],
    },
  ];
  const categories = await Promise.all(
    definitions.map(async ({ paths, ...category }) => ({
      ...category,
      locations: await Promise.all(
        paths.map((path) => inspectLocalDataLocation(join(root, path))),
      ),
    })),
  );
  return { dataDirectory: root, checkedAt: Date.now(), categories };
}
