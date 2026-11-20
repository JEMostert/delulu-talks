#!/bin/sh
set -eu
test "$(uname -m)" = arm64
export MACOSX_DEPLOYMENT_TARGET=15.0
triple=aarch64-apple-darwin
out=src-tauri/binaries
mkdir -p "$out"
cargo build --release --locked -p delulu-engine -p delulu-voice-cli
for helper in delulu-engine delulu; do
    cp "target/release/$helper" "$out/$helper-$triple"
done
swiftc -O -target arm64-apple-macos15.0 packaging/macos/pill.swift -o "$out/delulu-pill-$triple"
