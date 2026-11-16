#!/usr/bin/env bash
# Vendored transcribe.cpp: the upstream files the library needs (no ggml, tests,
# examples or bindings), plus transcribe.cpp.patch (build against delulu-engine's
# ggml, see vendor/README.md).
#
#   vendor/transcribe.cpp.sh verify    upstream REV + patch == vendor/transcribe.cpp
#   vendor/transcribe.cpp.sh diff      write the patch again from vendor/transcribe.cpp
#
# After an upgrade: set REV, re-apply the patch, compare ggml/UPSTREAM's sha with the
# ggml llama-cpp-sys-2 builds, rebuild, and rerun the transcript check.
set -euo pipefail

REV=275cd50d2c4104c204009a197ac091b9687668e5 # v0.4.2
PATHS=(CMakeLists.txt cmake include src LICENSE THIRD-PARTY-LICENSES.md)

here=$(cd "$(dirname "$0")" && pwd)
dest="$here/transcribe.cpp"
patch_file="$here/transcribe.cpp.patch"

# The upstream files at REV into directory $1.
upstream() {
    local out=$1
    timeout 300 curl -fsSL "https://codeload.github.com/handy-computer/transcribe.cpp/tar.gz/$REV" |
        tar -xz -C "$out" --strip-components=1 "${PATHS[@]/#/transcribe.cpp-$REV/}"
}

case ${1:-} in
verify)
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    upstream "$out"
    patch -s -p1 -d "$out" --no-backup-if-mismatch <"$patch_file"
    diff -r "$out" "$dest"
    echo "vendor/transcribe.cpp matches $REV plus transcribe.cpp.patch"
    ;;
diff)
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    mkdir "$out/a"
    upstream "$out/a"
    cp -a "$dest" "$out/b"
    (cd "$out" && diff -ruN a b >"$patch_file") || true
    echo "wrote $patch_file"
    ;;
*)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
