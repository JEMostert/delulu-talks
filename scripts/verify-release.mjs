import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Checks a draft GitHub release before publication: every platform package is
// present, and the updater manifest points at signed assets of this release.
// Usage: bun scripts/verify-release.mjs v0.1.0   (needs `gh` and GH_TOKEN)
const tag = process.argv[2];
assert.ok(tag, "Usage: verify-release.mjs <tag>");
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(tag, `v${version}`, "Tag does not match package.json version");

const gh = Bun.spawnSync(["gh", "release", "view", tag, "--json", "assets"]);
assert.equal(gh.exitCode, 0, gh.stderr.toString());
const assets = JSON.parse(gh.stdout.toString()).assets;
const names = assets.map((asset) => asset.name);
const find = (pattern, label) => {
  const name = names.find((candidate) => pattern.test(candidate));
  assert.ok(name, `Missing release asset: ${label}`);
  const asset = assets.find((candidate) => candidate.name === name);
  assert.ok(asset.size > 0, `Empty release asset: ${name}`);
  return name;
};

const updaterTargets = {
  "linux-x86_64": find(/_amd64\.AppImage$/, "Linux AppImage"),
  "darwin-aarch64": find(/aarch64\.app\.tar\.gz$/, "macOS updater archive"),
  "windows-x86_64": find(/_x64-setup\.exe$/, "Windows installer"),
};
find(/_amd64\.deb$/, "Linux deb");
find(/\.x86_64\.rpm$/, "Linux rpm");
find(/\.pkg\.tar\.zst$/, "Arch pacman package");
find(/_aarch64\.dmg$/, "macOS dmg");
for (const [target, name] of Object.entries(updaterTargets))
  assert.ok(names.includes(`${name}.sig`), `${target}: missing signature`);

const download = Bun.spawnSync([
  "gh",
  "release",
  "download",
  tag,
  "--pattern",
  "latest.json",
  "--output",
  "-",
]);
assert.equal(download.exitCode, 0, "Missing latest.json updater manifest");
const manifest = JSON.parse(download.stdout.toString());
assert.equal(manifest.version, version, "latest.json: wrong version");
for (const [target, name] of Object.entries(updaterTargets)) {
  const platform = manifest.platforms?.[target];
  assert.ok(platform, `latest.json: missing ${target}`);
  assert.ok(platform.signature?.length > 0, `latest.json: ${target} unsigned`);
  assert.ok(
    platform.url.endsWith(`/download/${tag}/${encodeURIComponent(name)}`) ||
      platform.url.endsWith(`/download/${tag}/${name}`),
    `latest.json: ${target} points at ${platform.url}, expected ${name}`,
  );
}
console.log(`Release ${tag} has ${names.length} assets and a valid updater manifest.`);
