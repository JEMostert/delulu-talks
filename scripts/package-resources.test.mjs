import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  icoImages,
  sourceManifest,
  verifyPackage,
} from "./package-resources.mjs";

const repository = resolve(import.meta.dir, "..");
const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function profile() {
  const root = mkdtempSync(join(tmpdir(), "delulu-package-resources-"));
  temporary.push(root);
  const manifest = sourceManifest(repository);
  copyFileSync(
    join(repository, "electron-builder.yml"),
    join(root, "electron-builder.yml"),
  );
  for (const source of new Set([
    ...manifest.resources.map((item) => item.from),
    ...Object.values(manifest.icons),
  ])) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    copyFileSync(join(repository, source), join(root, source));
  }
  return { root, manifest };
}
function artifact(root, manifest, platform) {
  const directory = join(root, "package");
  const resources =
    platform === "mac"
      ? join(directory, "Contents/Resources")
      : join(directory, "resources");
  for (const item of manifest.resources) {
    mkdirSync(dirname(join(resources, item.to)), { recursive: true });
    copyFileSync(join(root, item.from), join(resources, item.to));
  }
  writeFileSync(
    join(resources, "app.asar"),
    "ASAR existence fixture; launch is separately verified",
  );
  if (platform === "mac") {
    copyFileSync(join(root, manifest.icons.mac), join(resources, "icon.icns"));
    mkdirSync(join(directory, "Contents/MacOS"));
    writeFileSync(
      join(directory, "Contents/MacOS/Delulu Talks"),
      "executable fixture",
    );
    writeFileSync(
      join(directory, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundleExecutable</key><string>Delulu Talks</string></dict></plist>",
    );
  } else if (platform === "win") {
    writeFileSync(
      join(directory, "Delulu Talks.exe"),
      Buffer.concat([
        Buffer.from("PE fixture"),
        ...icoImages(readFileSync(join(root, manifest.icons.win))),
      ]),
    );
  } else writeFileSync(join(directory, "delulu-talks"), "executable fixture");
  return { directory, resources };
}

test("configured resources include every speech adapter, constraint, notice and tray template", () => {
  const manifest = sourceManifest(repository);
  expect(manifest.resources).toHaveLength(17);
  expect(manifest.linuxSize).toEqual([1024, 1024]);
});
for (const platform of ["linux", "mac", "win"]) {
  test(`${platform} resource verification rejects omitted and stale packaged adapters without changing artifacts`, () => {
    const { root, manifest } = profile();
    const { directory, resources } = artifact(root, manifest, platform);
    expect(verifyPackage(root, directory, platform).resources).toHaveLength(17);
    const checkpoint = join(resources, "python/windows_checkpoint.py");
    const bytes = readFileSync(checkpoint);
    rmSync(checkpoint);
    expect(() => verifyPackage(root, directory, platform)).toThrow();
    writeFileSync(
      checkpoint,
      Buffer.concat([bytes, Buffer.from("\n# stale packaged adapter\n")]),
    );
    const stale = readFileSync(checkpoint);
    expect(() => verifyPackage(root, directory, platform)).toThrow(
      "Packaged bytes differ",
    );
    expect(readFileSync(checkpoint)).toEqual(stale);
  });
}

test("Mac bundle must reference and contain the configured native icon", () => {
  const { root, manifest } = profile();
  const { directory, resources } = artifact(root, manifest, "mac");
  writeFileSync(join(resources, "icon.icns"), "unrelated default icon");
  expect(() => verifyPackage(root, directory, "mac")).toThrow(
    "bundle icon differs",
  );
});

test("Windows executable must actually contain the configured icon payloads", () => {
  const { root, manifest } = profile();
  const { directory } = artifact(root, manifest, "win");
  writeFileSync(
    join(directory, "Delulu Talks.exe"),
    "Electron default icon fixture",
  );
  expect(() => verifyPackage(root, directory, "win")).toThrow(
    "missing a configured icon image",
  );
});

test("required mappings, duplicate destinations, malformed native icons and missing retina templates fail source verification", () => {
  for (const mutate of [
    (config) => config.extraResources.pop(),
    (config) => config.extraResources.push(config.extraResources[0]),
    (config) => {
      config.extraResources[0].from = config.extraResources[1].from;
    },
    (config, root) => writeFileSync(join(root, config.win.icon), "broken ICO"),
    (_config, root) => rmSync(join(root, "build/trayTemplate@2x.png")),
  ]) {
    const { root } = profile();
    const config = Bun.YAML.parse(
      readFileSync(join(root, "electron-builder.yml"), "utf8"),
    );
    mutate(config, root);
    writeFileSync(join(root, "electron-builder.yml"), JSON.stringify(config));
    expect(() => sourceManifest(root)).toThrow();
  }
});
