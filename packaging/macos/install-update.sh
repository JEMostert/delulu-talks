# Embedded in the application. System Applications updates run this exact
# script after macOS authorization. Other destinations use the current user.
set -euo pipefail
archive=$1
digest=$2
target=$3
current=$4
next=$5
fail() { echo "$*" >&2; exit 1; }
if [[ $EUID == 0 ]]; then
    [[ $target == '/Applications/Delulu Talks.app' ]] || fail 'Unexpected system installation path.'
    stage_root=/private/var/tmp
else
    stage_root=$(/usr/bin/dirname "$target")
fi
stage=$(/usr/bin/mktemp -d "$stage_root/.delulu-update.XXXXXXXX") || exit 1
trap '/bin/rm -rf "$stage"' EXIT
/bin/cat "$archive" > "$stage/archive"
actual=$(/usr/bin/shasum -a 256 "$stage/archive")
[[ ${actual%% *} == "$digest" ]] || fail 'The verified archive changed.'
/usr/bin/tar --no-same-owner -xzf "$stage/archive" -C "$stage"
app="$stage/Delulu Talks.app"
version() { /usr/bin/plutil -extract CFBundleShortVersionString raw "$1/Contents/Info.plist"; }
[[ $(version "$app") == "$next" ]] || fail 'Unexpected application version.'
/usr/bin/codesign --verify --deep --strict "$app"
[[ ! -L $target && $(version "$target") == "$current" ]] || fail 'The installed app changed. Quit and reopen it.'
# Both bundles stay in place if the filesystem cannot exchange them. The old
# bundle only enters our private cleanup directory after a successful swap.
result=$(/usr/bin/osascript -l JavaScript -e 'function run(args) {
    ObjC.import("stdio");
    return $.renamex_np(args[0], args[1], 2) === 0 ? "swapped" : "failed";
}' "$app" "$target")
[[ $result == swapped ]] || fail 'Move Delulu Talks to Applications on the startup disk and reopen it.'
