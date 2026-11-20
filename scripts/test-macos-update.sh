#!/bin/bash
set -euo pipefail
archive=$1
version=$(node -p 'require("./package.json").version')
digest=$(/usr/bin/shasum -a 256 "$archive")
digest=${digest%% *}
# Only a disposable hosted runner may create the system-install fixture.
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
/usr/bin/osacompile -o "$RUNNER_TEMP/authorize-update.scpt" packaging/macos/authorize-update.applescript
target='/Applications/Delulu Talks.app'
sudo -n mkdir "$target"  # exclusive; leave any existing installation alone
trap 'sudo -n rm -rf "$target"' EXIT
sudo -n mkdir "$target/Contents"
sudo -n plutil -create xml1 "$target/Contents/Info.plist"
sudo -n plutil -insert CFBundleShortVersionString -string 0.1.0 "$target/Contents/Info.plist"
install_fixture() {
    sudo -n /bin/bash -p packaging/macos/install-update.sh "$archive" "$1" "$target" "$2" "$version"
}
if install_fixture bad-digest 0.1.0; then exit 1; fi
if install_fixture "$digest" 0.0.1; then exit 1; fi
test "$(plutil -extract CFBundleShortVersionString raw "$target/Contents/Info.plist")" = 0.1.0
install_fixture "$digest" 0.1.0
codesign --verify --deep --strict "$target"
test "$("$target/Contents/MacOS/delulu" --version)" = "delulu $version"
