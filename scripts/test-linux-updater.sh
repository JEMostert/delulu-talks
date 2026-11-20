#!/usr/bin/env bash
# Run the installed helper inside a disposable Ubuntu container with a test key.
set -euo pipefail
engine=${CONTAINER_ENGINE:-docker}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
"$engine" run -i --rm ubuntu:24.04 bash -se > "$work/fixture.deb" <<'BUILD'
mkdir -p /tmp/pkg/{DEBIAN,usr/share/delulu-fixture}
printf 'Package: delulu-updater-fixture\nVersion: 9.1.0\nArchitecture: all\nMaintainer: CI <ci@example.org>\nDescription: Updater test\n' > /tmp/pkg/DEBIAN/control
echo updated > /tmp/pkg/usr/share/delulu-fixture/version
dpkg-deb --root-owner-group --build /tmp/pkg /tmp/fixture.deb >/dev/null
cat /tmp/fixture.deb
BUILD
bun tauri signer generate --ci -p test-only -w "$work/key" >/dev/null
TAURI_SIGNING_PRIVATE_KEY_PATH="$work/key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test-only \
  bun tauri signer sign --app-version 9.1.0 "$work/fixture.deb" >/dev/null
base64 -d < "$work/key.pub" > "$work/updater.pub"
rm "$work/key"
cp packaging/install-update "$work/"
"$engine" run -i --rm -v "$work:/fixture:ro,Z" ubuntu:24.04 bash -se <<'TEST'
apt-get -qq update
apt-get -y -qq install minisign >/dev/null
mkdir -p /usr/libexec/delulu-talks
cp /fixture/{install-update,updater.pub} /usr/libexec/delulu-talks/
helper=/usr/libexec/delulu-talks/install-update
sig=$(cat /fixture/fixture.deb.sig)
if "$helper" .deb 9.1.0 "$sig" <<< tampered; then exit 1; fi
if "$helper" .deb 9.2.0 "$sig" < /fixture/fixture.deb; then exit 1; fi
test ! -e /usr/share/delulu-fixture/version
"$helper" .deb 9.1.0 "$sig" < /fixture/fixture.deb
test "$(cat /usr/share/delulu-fixture/version)" = updated
TEST
