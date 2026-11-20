#!/bin/bash
set -euo pipefail
dmg=${1:?usage: verify-macos.sh path/to/arm64.dmg}
version=$(node -p 'require("./package.json").version')
tmp=$(mktemp -d)
mount="$tmp/volume"
mkdir -p "$mount" "$tmp/profile"
attached=false
cleanup() {
    if "$attached"; then hdiutil detach "$mount" || return 1; fi
    rm -rf "$tmp"
}
trap cleanup EXIT
hdiutil verify "$dmg"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount" "$dmg"
attached=true
app="$mount/Delulu Talks.app"
plist="$app/Contents/Info.plist"
bin="$app/Contents/MacOS"
test "$(plutil -extract CFBundleShortVersionString raw "$plist")" = "$version"
test -n "$(plutil -extract NSMicrophoneUsageDescription raw "$plist")"
for name in delulu-talks delulu-engine delulu delulu-pill; do
    test "$(lipo -archs "$bin/$name")" = arm64
    if [[ $name != delulu-talks ]]; then codesign --verify --strict "$bin/$name"; fi
    otool -L "$bin/$name"
done
codesign --verify --deep --strict "$app"
test "$("$bin/delulu" --version)" = "delulu $version"
"$bin/delulu-engine" probe > "$tmp/probe.json"
HOME="$tmp/profile" "$bin/delulu" status > "$tmp/voice.json"
node - "$tmp" "$version" "$bin/delulu-engine" <<'JS'
const fs = require("node:fs");
const [dir, version, engine] = process.argv.slice(2);
const probe = JSON.parse(fs.readFileSync(dir + "/probe.json"));
const voice = JSON.parse(fs.readFileSync(dir + "/voice.json"));
if (probe.version !== version || !["stt","llm","tts","music"].every(r => probe.roles.includes(r)) || !voice.engineBinary || fs.realpathSync(voice.engineBinary) !== fs.realpathSync(engine) || !voice.configured)
  throw Error("Packaged engine or voice CLI unavailable");
console.log("Packaged compute device:", probe.device);
JS

# A hosted runner has a disposable login session. Launch the actual bundle
# there and require its visible window, without touching a developer's desktop.
if [[ ${GITHUB_ACTIONS:-} == true ]]; then
    HOME="$tmp/profile" DELULU_NO_PORTALS=1 "$bin/delulu-talks" &
    app_pid=$!
    trap 'kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; cleanup' EXIT
    swift - "$app_pid" <<'SWIFT'
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
for _ in 0..<60 {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
    if windows.contains(where: { $0[kCGWindowOwnerPID as String] as? Int == pid && $0[kCGWindowLayer as String] as? Int == 0 }) { exit(0) }
    Thread.sleep(forTimeInterval: 0.5)
}
fatalError("The packaged app did not show its main window")
SWIFT
fi
