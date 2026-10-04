import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_RESOURCES = [
  "python/transcription_engine.py",
  "python/speech_engine.py",
  "python/spoken_corrections.py",
  "python/verified_snapshot.py",
  "python/cuda_preflight.py",
  "python/worker_protocol.py",
  "python/download_progress.py",
  "python/metal_speech.py",
  "python/windows_speech.py",
  "python/windows_checkpoint.py",
  "python/constraints-linux-x64.txt",
  "python/THIRD_PARTY_NOTICES.md",
  "python/licenses/transformers-Apache-2.0.txt",
  "overlay/pill.py",
  "icon.png",
  ...["idle", "recording", "busy", "attention", "update"].flatMap((state) => [
    `tray/tray-${state}.png`,
    `tray/tray-${state}@2x.png`,
    `tray/tray-${state}.ico`,
    `tray/tray-${state}Template.png`,
    `tray/tray-${state}Template@2x.png`,
  ]),
];

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function inside(root, name) {
  assert.equal(
    isAbsolute(name),
    false,
    `Resource path must be relative: ${name}`,
  );
  const path = resolve(root, name);
  assert.ok(
    path.startsWith(resolve(root) + sep),
    `Resource path escapes root: ${name}`,
  );
  return path;
}
function bytes(path) {
  assert.ok(statSync(path).isFile(), `Expected packaged file: ${path}`);
  return readFileSync(path);
}
export function pngSize(buffer) {
  assert.ok(
    buffer.length >= 24 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Invalid PNG icon",
  );
  const size = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  assert.ok(
    size.every((value) => value > 0),
    "PNG icon has no pixels",
  );
  return size;
}
export function icoImages(buffer) {
  assert.ok(
    buffer.length >= 6 &&
      buffer.readUInt16LE(0) === 0 &&
      buffer.readUInt16LE(2) === 1,
    "Invalid Windows icon",
  );
  const count = buffer.readUInt16LE(4);
  assert.ok(
    count > 0 && buffer.length >= 6 + count * 16,
    "Windows icon has no image directory",
  );
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16;
    const size = buffer.readUInt32LE(entry + 8),
      offset = buffer.readUInt32LE(entry + 12);
    assert.ok(
      size > 0 && offset >= 6 + count * 16 && offset + size <= buffer.length,
      "Truncated Windows icon image",
    );
    return buffer.subarray(offset, offset + size);
  });
}
function icns(buffer) {
  assert.ok(
    buffer.length >= 8 &&
      buffer.subarray(0, 4).toString() === "icns" &&
      buffer.readUInt32BE(4) === buffer.length,
    "Invalid macOS icon",
  );
}

export function sourceManifest(root = process.cwd()) {
  const config = Bun.YAML.parse(
    readFileSync(join(root, "electron-builder.yml"), "utf8"),
  );
  assert.ok(
    Array.isArray(config.extraResources),
    "Packaging must declare external runtime resources",
  );
  const seen = new Set();
  const resources = config.extraResources.map((entry) => {
    assert.ok(
      typeof entry.from === "string" &&
        typeof entry.to === "string" &&
        !entry.filter,
      "Resource verifier requires explicit file mappings",
    );
    assert.ok(
      !seen.has(entry.to),
      `Duplicate resource destination: ${entry.to}`,
    );
    seen.add(entry.to);
    inside(root, entry.to);
    const content = bytes(inside(root, entry.from));
    assert.ok(content.length > 0, `Empty resource: ${entry.from}`);
    return {
      from: entry.from,
      to: entry.to,
      sha256: hash(content),
      size: content.length,
    };
  });
  for (const name of REQUIRED_RESOURCES)
    assert.ok(seen.has(name), `Missing required resource mapping: ${name}`);
  for (const resource of resources) {
    if (!REQUIRED_RESOURCES.includes(resource.to)) continue;
    const expected =
      resource.to === "python/THIRD_PARTY_NOTICES.md"
        ? "docs/THIRD_PARTY_NOTICES.md"
        : resource.to === "python/licenses/transformers-Apache-2.0.txt"
          ? "docs/licenses/transformers-Apache-2.0.txt"
          : resource.to.startsWith("python/")
            ? `electron/${resource.to}`
            : resource.to.startsWith("overlay/")
              ? `electron/${resource.to}`
              : `build/${resource.to}`;
    assert.equal(
      resource.from,
      expected,
      `Required resource mapped from wrong source: ${resource.to}`,
    );
  }
  const icons = {
    linux: config.linux?.icon,
    mac: config.mac?.icon,
    win: config.win?.icon,
  };
  assert.ok(
    Object.values(icons).every((icon) => typeof icon === "string"),
    "Every platform must declare a native icon",
  );
  const linuxSize = pngSize(bytes(inside(root, icons.linux)));
  icns(bytes(inside(root, icons.mac)));
  icoImages(bytes(inside(root, icons.win)));
  for (const state of ["idle", "recording", "busy", "attention", "update"]) {
    for (const base of [`tray-${state}`, `tray-${state}Template`]) {
      const tray = pngSize(bytes(join(root, `build/tray/${base}.png`)));
      const retina = pngSize(bytes(join(root, `build/tray/${base}@2x.png`)));
      assert.deepEqual(
        retina,
        tray.map((value) => value * 2),
        `Tray image ${base} must include an exact 2x companion`,
      );
    }
    icoImages(bytes(join(root, `build/tray/tray-${state}.ico`)));
  }
  return { config, resources, icons, linuxSize };
}

function plistValue(text, key) {
  const match = text.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`),
  );
  assert.ok(match, `macOS bundle is missing ${key}`);
  assert.equal(
    basename(match[1]),
    match[1],
    `Unexpected bundle filename for ${key}`,
  );
  return match[1];
}

export function verifyPackage(root, packageDirectory, platform) {
  assert.ok(
    ["linux", "mac", "win"].includes(platform),
    "Choose linux, mac or win",
  );
  const manifest = sourceManifest(root);
  const resourceDirectory =
    platform === "mac"
      ? join(packageDirectory, "Contents/Resources")
      : join(packageDirectory, "resources");
  for (const resource of manifest.resources) {
    assert.equal(
      hash(bytes(inside(resourceDirectory, resource.to))),
      resource.sha256,
      `Packaged bytes differ: ${resource.to}`,
    );
  }
  bytes(join(resourceDirectory, "app.asar"));
  if (platform === "mac") {
    const plist = readFileSync(
      join(packageDirectory, "Contents/Info.plist"),
      "utf8",
    );
    const icon = plistValue(plist, "CFBundleIconFile");
    assert.equal(
      hash(bytes(join(resourceDirectory, icon))),
      hash(bytes(inside(root, manifest.icons.mac))),
      "macOS bundle icon differs from configured source",
    );
    bytes(
      join(
        packageDirectory,
        "Contents/MacOS",
        plistValue(plist, "CFBundleExecutable"),
      ),
    );
  } else if (platform === "win") {
    const executable = bytes(
      join(packageDirectory, `${manifest.config.productName}.exe`),
    );
    for (const image of icoImages(bytes(inside(root, manifest.icons.win))))
      assert.ok(
        executable.includes(image),
        "Windows executable is missing a configured icon image",
      );
  } else {
    bytes(join(packageDirectory, manifest.config.linux.executableName));
    const packagedIcon = manifest.resources.find(
      (resource) => resource.to === "icon.png",
    );
    assert.equal(
      packagedIcon.sha256,
      hash(bytes(inside(root, manifest.icons.linux))),
      "Linux packaged icon differs from configured native icon",
    );
  }
  return {
    platform,
    packageDirectory: resolve(packageDirectory),
    resourceDirectory: resolve(resourceDirectory),
    resources: manifest.resources,
    scope:
      "fixture-only packaged bytes and native icon content; no inference, launch or manual desktop evidence",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [directory, platform] = process.argv.slice(2);
  assert.ok(
    directory && platform && process.argv.length === 4,
    "Use bun scripts/package-resources.mjs <unpacked-directory-or-app> <linux|mac|win>",
  );
  console.log(
    JSON.stringify(
      verifyPackage(process.cwd(), resolve(directory), platform),
      null,
      2,
    ),
  );
}
