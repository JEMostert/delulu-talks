import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Verifies that a Tauri build bundled every resource from tauri.conf.json,
// byte-for-byte, where the app resolves them at runtime.
// Usage: bun scripts/package-resources.mjs <src-tauri/target> <linux-x64|mac-arm64|windows-x64>
const root = resolve(import.meta.dir, "..");
const target = resolve(process.argv[2] ?? "src-tauri/target");
const platform = process.argv[3] ?? "linux-x64";
const config = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
const resources = config.bundle.resources;

export const REQUIRED_RESOURCES = [
  "python/transcription_engine.py",
  "python/worker_protocol.py",
  "python/onnx_speech.py",
  "python/voice_engine.py",
  "python/constraints-linux-x64.txt",
  "overlay/pill.py",
  "voice/skill/SKILL.md",
  "icon.png",
  "tray/tray-idle.png",
  "tray/tray-recording.png",
];

const destinations = Object.values(resources);
assert.equal(
  new Set(destinations).size,
  destinations.length,
  "Duplicate resource destinations",
);
for (const required of REQUIRED_RESOURCES)
  assert.ok(destinations.includes(required), `Not configured: ${required}`);
for (const source of Object.keys(resources))
  assert.ok(
    statSync(join(root, "src-tauri", source)).isFile(),
    `Missing source: ${source}`,
  );

function findResourceRoot() {
  const marker = join("overlay", "pill.py");
  const candidates = [];
  const walk = (directory, depth) => {
    if (depth > 12 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "deps") continue;
      const path = join(directory, entry.name);
      if (existsSync(join(path, marker))) candidates.push(path);
      walk(path, depth + 1);
    }
  };
  walk(target, 0);
  const preferred = {
    "linux-x64": (path) => path.includes(join("bundle", "deb")),
    "mac-arm64": (path) => path.endsWith(join("Contents", "Resources")),
    "windows-x64": () => true,
  }[platform];
  assert.ok(preferred, `Unknown platform ${platform}`);
  const found = candidates.find(preferred);
  assert.ok(found, `No bundled resources found under ${target}`);
  return found;
}

const resourceRoot = findResourceRoot();
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
for (const [source, destination] of Object.entries(resources)) {
  const bundled = join(resourceRoot, destination);
  assert.ok(existsSync(bundled), `Not bundled: ${destination}`);
  assert.equal(
    digest(bundled),
    digest(join(root, "src-tauri", source)),
    `Bundled bytes differ: ${destination}`,
  );
}
assert.ok(existsSync(dirname(resourceRoot)));
console.log(
  `${destinations.length} resources verified in ${resourceRoot} (${platform}).`,
);
