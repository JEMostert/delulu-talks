import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLocalDataLocation, localDataOverview } from "./localData";

test("measures all five categories independently without changing files or following links", async () => {
  const root = await mkdtemp(join(tmpdir(), "delulu-data-overview-"));
  try {
    const fixture = {
      "history.json": "original transcript",
      "history.json.tmp": "interrupted write",
      "settings.json": "private settings",
      "settings.json.tmp": "pending settings",
      "models/hub/blobs/model": "model bytes",
      "speech-venv/lib/runtime": "speech packages",
      "magic-venv/lib/runtime": "writing packages",
      "asr-venv/lib/runtime": "legacy packages",
      "audio-cache/failed.wav": "retained audio",
      "external/original.wav": "not app managed",
    };
    for (const [relative, bytes] of Object.entries(fixture)) {
      await mkdir(join(root, relative, ".."), { recursive: true });
      await writeFile(join(root, relative), bytes);
    }
    await mkdir(join(root, "models/hub/snapshots"), { recursive: true });
    await symlink("../blobs/model", join(root, "models/hub/snapshots/model"));
    await symlink(join(root, "external"), join(root, "audio-cache/external"));
    const overview = await localDataOverview({ dataDirectory: root });
    expect(overview.categories.map((category) => category.id)).toEqual([
      "history",
      "settings",
      "models",
      "runtimes",
      "audio",
    ]);
    const total = (id: string) =>
      overview.categories
        .find((category) => category.id === id)!
        .locations.reduce((sum, item) => sum + item.bytes, 0);
    expect(total("history")).toBe(
      Buffer.byteLength(fixture["history.json"] + fixture["history.json.tmp"]),
    );
    expect(total("settings")).toBe(
      Buffer.byteLength(
        fixture["settings.json"] + fixture["settings.json.tmp"],
      ),
    );
    expect(total("models")).toBe(
      Buffer.byteLength(fixture["models/hub/blobs/model"]),
    );
    expect(total("runtimes")).toBe(
      Buffer.byteLength("speech packageswriting packageslegacy packages"),
    );
    expect(total("audio")).toBe(Buffer.byteLength("retained audio"));
    expect(
      overview.categories.find((category) => category.id === "models")!
        .locations[0].skippedLinks,
    ).toBe(1);
    expect(
      overview.categories.find((category) => category.id === "audio")!
        .locations[0].skippedLinks,
    ).toBe(1);
    for (const [relative, bytes] of Object.entries(fixture))
      expect(await readFile(join(root, relative), "utf8")).toBe(bytes);
    // No folders or defaults are created by inspection.
    const missing = join(root, "absent-profile");
    const empty = await localDataOverview({ dataDirectory: missing });
    expect(
      empty.categories
        .flatMap((category) => category.locations)
        .every(
          (location) => location.status === "missing" && location.bytes === 0,
        ),
    ).toBe(true);
    expect(await lstat(missing).catch(() => null)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable and disappearing files return partial measurements while other entries remain visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "delulu-data-errors-"));
  try {
    await writeFile(join(root, "readable"), "12345");
    await mkdir(join(root, "denied"));
    const overview = await inspectLocalDataLocation(root, {
      lstat: async (path) => {
        if (String(path).endsWith("vanished"))
          throw Object.assign(new Error("vanished"), { code: "ENOENT" });
        return lstat(path);
      },
      readdir: async (path) => {
        if (String(path).endsWith("denied"))
          throw Object.assign(new Error("permission"), { code: "EACCES" });
        const names = await readdir(path);
        return String(path) === root ? [...names, "vanished"] : names;
      },
    });
    expect(overview.status).toBe("partial");
    expect(overview.bytes).toBe(5);
    expect(overview.files).toBe(1);
    expect(overview.problems.join(" ")).toContain("EACCES");
    expect(overview.problems.join(" ")).toContain("ENOENT");
    const deniedRoot = await inspectLocalDataLocation(root, {
      lstat: async () => {
        throw Object.assign(new Error("permission"), { code: "EACCES" });
      },
      readdir,
    });
    expect(deniedRoot.status).toBe("partial");
    expect(deniedRoot.status).not.toBe("missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
