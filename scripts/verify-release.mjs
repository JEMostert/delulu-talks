import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// Run with Bun against the merged native build artifacts before publication.
const directory = resolve(process.argv[2] ?? "artifacts");
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const prefix = `Delulu-Talks-${version}`;
const required = [
  `${prefix}-linux-x86_64.AppImage`,
  `${prefix}-linux-x64.pacman`,
  `${prefix}-linux-x64.tar.xz`,
  `${prefix}-mac-arm64.dmg`,
  `${prefix}-mac-arm64.zip`,
  `${prefix}-mac-arm64.zip.blockmap`,
  `${prefix}-win-x64.exe`,
  `${prefix}-win-x64.exe.blockmap`,
  `${prefix}-win-x64.zip`,
];
for (const name of required) {
  const file = await stat(join(directory, name));
  assert.ok(file.isFile() && file.size > 0, `Missing release asset: ${name}`);
}

for (const [metadata, installFile] of [
  ["latest-linux.yml", `${prefix}-linux-x86_64.AppImage`],
  ["latest-mac.yml", `${prefix}-mac-arm64.zip`],
  ["latest.yml", `${prefix}-win-x64.exe`],
]) {
  const manifest = Bun.YAML.parse(
    await readFile(join(directory, metadata), "utf8"),
  );
  assert.equal(manifest.version, version, `${metadata}: wrong version`);
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.length,
    `${metadata}: missing files`,
  );
  assert.ok(
    manifest.files.some((file) => file.url === installFile),
    `${metadata}: missing installer`,
  );
  for (const file of manifest.files) {
    assert.equal(
      basename(file.url),
      file.url,
      `${metadata}: invalid asset path`,
    );
    const path = join(directory, file.url);
    assert.equal(
      (await stat(path)).size,
      file.size,
      `${file.url}: size mismatch`,
    );
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assert.equal(
      hash.digest("base64"),
      file.sha512,
      `${file.url}: checksum mismatch`,
    );
  }
  const primary = manifest.files.find((file) => file.url === manifest.path);
  assert.ok(primary, `${metadata}: primary asset missing`);
  assert.equal(
    manifest.sha512,
    primary.sha512,
    `${metadata}: primary checksum mismatch`,
  );
  console.log(
    `${metadata}: v${version}, installer and all file checksums verified`,
  );
}
console.log(
  `Release v${version}: all native packages and updater metadata are complete.`,
);
