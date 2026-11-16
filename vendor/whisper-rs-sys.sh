#!/usr/bin/env bash
# Vendored whisper-rs-sys: the crates.io release without whisper.cpp's bundled ggml
# and bindings, plus whisper-rs-sys.patch (whisper.cpp against delulu-engine's ggml).
#
#   vendor/whisper-rs-sys.sh verify    crates.io release + patch == vendor/whisper-rs-sys
#   vendor/whisper-rs-sys.sh diff      write the patch again from vendor/whisper-rs-sys
#
# After a whisper-rs-sys or llama-cpp-2 bump: re-apply the patch, update VERSION and
# SHA256 below, rebuild, and rerun the transcript check in vendor/README.md.
set -euo pipefail

VERSION=0.15.0
SHA256=6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f
# Not vendored: whisper.cpp's own ggml (the engine links llama-cpp-sys-2's), the
# bindings generated for it, and crates.io packaging files.
REMOVED=(whisper.cpp/ggml src/bindings.rs Cargo.lock Cargo.toml.orig .cargo_vcs_info.json)

here=$(cd "$(dirname "$0")" && pwd)
dest="$here/whisper-rs-sys"
patch_file="$here/whisper-rs-sys.patch"

# The release, minus REMOVED, into directory $1/whisper-rs-sys.
release() {
    local out=$1 crate
    crate="$out/whisper-rs-sys-$VERSION.crate"
    timeout 300 curl -fsSL -o "$crate" \
        "https://static.crates.io/crates/whisper-rs-sys/whisper-rs-sys-$VERSION.crate"
    echo "$SHA256  $crate" | sha256sum -c --quiet
    tar -xzf "$crate" -C "$out"
    mv "$out/whisper-rs-sys-$VERSION" "$out/whisper-rs-sys"
    for path in "${REMOVED[@]}"; do
        rm -rf "${out:?}/whisper-rs-sys/$path"
    done
}

case ${1:-} in
verify)
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    release "$out"
    patch -s -p1 -d "$out/whisper-rs-sys" --no-backup-if-mismatch <"$patch_file"
    diff -r "$out/whisper-rs-sys" "$dest"
    echo "vendor/whisper-rs-sys matches whisper-rs-sys $VERSION plus whisper-rs-sys.patch"
    ;;
diff)
    out=$(mktemp -d)
    trap 'rm -rf "$out"' EXIT
    release "$out"
    mv "$out/whisper-rs-sys" "$out/a"
    cp -a "$dest" "$out/b"
    (cd "$out" && diff -ruN a b >"$patch_file") || true
    echo "wrote $patch_file"
    ;;
*)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
