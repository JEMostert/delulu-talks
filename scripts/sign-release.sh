#!/usr/bin/env bash
set -euo pipefail
bundles=$1
out=$2
version=$(node -p 'require("./package.json").version')
[[ ${GITHUB_REF_NAME:?} == "v$version" && $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
mkdir "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node -p 'require("./src-tauri/tauri.conf.json").plugins.updater.pubkey' | base64 -d > "$tmp/public.key"

copy_asset() {
  local target=$1
  shift
  [[ $# == 1 && -s "$1" ]]
  local name
  name=$(basename "$1" | tr ' ' '.')
  [[ $name =~ ^[a-zA-Z0-9._-]+$ ]]
  cp "$1" "$out/$name"
  if [[ $target != dmg ]]; then
    bun tauri signer sign --app-version "$version" "$out/$name" >/dev/null
    base64 -d < "$out/$name.sig" > "$tmp/signature"
    minisign -Vm "$out/$name" -x "$tmp/signature" -p "$tmp/public.key"
    printf '%s\t%s\n' "$target" "$name" >> "$tmp/platforms"
  fi
}
copy_asset dmg "$bundles"/macos-arm64/*.dmg
copy_asset darwin-aarch64 "$bundles"/macos-arm64/*.app.tar.gz
copy_asset linux-x86_64-deb "$bundles"/linux-bundles/deb/*.deb
copy_asset linux-x86_64-rpm "$bundles"/linux-bundles/rpm/*.rpm
copy_asset linux-x86_64-pacman "$bundles"/pacman/*.pkg.tar.zst
node --input-type=module - "$out" "$version" "$tmp/platforms" <<'JS'
import fs from 'node:fs';
const [out, version, list] = process.argv.slice(2);
const platforms = {};
for (const row of fs.readFileSync(list, 'utf8').trim().split('\n')) {
  const [target, name] = row.split('\t');
  const signatureFile = `${out}/${name}.sig`;
  platforms[target] = {
    signature: fs.readFileSync(signatureFile, 'utf8').trim(),
    url: `https://github.com/JEMostert/delulu-talks/releases/download/v${version}/${name}`
  };
  // pacman reserves <package>.sig for detached OpenPGP signatures.
  if (target === 'linux-x86_64-pacman') fs.renameSync(signatureFile, `${out}/${name}.tauri.sig`);
}
fs.writeFileSync(`${out}/latest.json`, JSON.stringify({version, platforms}, null, 2));
JS
