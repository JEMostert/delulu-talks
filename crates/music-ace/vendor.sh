#!/usr/bin/env bash
# Vendored acestep.cpp: the upstream files the core library needs, byte for byte,
# plus the patches in patches/, applied in name order.
#
#   crates/music-ace/vendor.sh verify          upstream REV + patches == vendor/acestep.cpp
#   crates/music-ace/vendor.sh update <rev>    re-import at <rev>, re-apply the patches
#
# ACESTEP_GIT=<url or local clone> fetches from somewhere else (default: upstream).
# After an update: set REV below, rebuild, and rerun the parity and song checks in
# crates/music-ace/README.md, because acestep.cpp is built against the app's ggml.
set -euo pipefail

REV=603e68284c34cebb8485dbb4b8cb2549f9cded56
REPO=${ACESTEP_GIT:-https://github.com/ServeurpersoCom/acestep.cpp.git}
PATHS=(LICENSE src vendor/yyjson)

here=$(cd "$(dirname "$0")" && pwd)
dest="$here/vendor/acestep.cpp"

# Upstream files at $1, with the patches applied, into directory $2.
export_tree() {
    local rev=$1 out=$2 git_dir
    git_dir=$(mktemp -d)
    git -C "$git_dir" init -q
    timeout 300 git -C "$git_dir" fetch -q --depth 1 "$REPO" "$rev"
    git -C "$git_dir" archive FETCH_HEAD "${PATHS[@]}" | tar -x -C "$out"
    rm -rf "$git_dir"
    for p in "$here"/patches/*.patch; do
        [ -e "$p" ] || continue
        patch -s -p1 -d "$out" --no-backup-if-mismatch <"$p"
    done
}

case ${1:-} in
verify)
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    export_tree "$REV" "$out"
    diff -r "$out" "$dest"
    echo "vendor/acestep.cpp matches $REV plus $(ls "$here"/patches/*.patch 2>/dev/null | wc -l) patch(es)"
    ;;
update)
    rev=${2:?usage: vendor.sh update <rev>}
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    export_tree "$rev" "$out"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -a "$out"/. "$dest"/
    echo "imported $rev; now set REV=$rev in $0"
    ;;
*)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
