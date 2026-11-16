# Vendored crates

## whisper-rs-sys 0.15.0: whisper.cpp on the engine's one ggml

`delulu-engine` links whisper.cpp (for the `stt` role), llama.cpp, the YuE2 code
and acestep.cpp. The crates.io `whisper-rs-sys` builds whisper.cpp with its own
bundled ggml, which would put a second, older ggml and a second Vulkan shader blob
(about 36 MB) into the binary. `vendor/whisper-rs-sys` is that release with
whisper.cpp's `ggml/` directory and its pre-generated bindings removed, plus
`whisper-rs-sys.patch`. The root `Cargo.toml` uses it through `[patch.crates-io]`;
`whisper-rs` itself stays the crates.io release.

The patch:

- depends on `llama-cpp-sys-2` (without features), whose build exports
  `DEP_LLAMA_GGML_CMAKE_DIR` for exactly this, and builds whisper.cpp with
  `WHISPER_USE_SYSTEM_GGML=ON` against that installed ggml;
- runs bindgen on that ggml's headers (and fails the build if bindgen fails,
  instead of falling back to stale bindings);
- compiles whisper.cpp and the bindings with the same `GGML_MAX_NAME` as the ggml
  (`.cargo/config.toml`; it changes `struct ggml_tensor`), through
  `shared-ggml.cmake`, which CMake includes right after `project(whisper.cpp)`;
- adds `layout.c` to the whisper library: `sizeof(struct ggml_tensor)` as
  whisper.cpp sees it. `delulu-engine stt` compares it with the linked ggml before
  each model load, and the test
  `whisper_and_the_linked_ggml_agree_on_tensor_layout` fails on a mismatch (a
  stale build directory: `cargo clean -p llama-cpp-sys-2`);
- links only `libwhisper.a`; llama-cpp-sys-2 links ggml.

No whisper.cpp source changes. whisper.cpp v1.8.3 compiles unchanged against the
ggml of llama.cpp `d812350` (llama-cpp-sys-2 0.1.160). On clean speech the
transcripts are byte for byte what whisper.cpp's own ggml gives; on audio Whisper
can barely read, a few near-ties come out differently (the ggml is about nine months
newer).

```sh
vendor/whisper-rs-sys.sh verify   # crates.io release + patch == vendor/whisper-rs-sys
vendor/whisper-rs-sys.sh diff     # rewrite the patch after editing the vendored crate
```

**Upgrades.** A `llama-cpp-2` bump now also changes Whisper's ggml: rerun a
transcript comparison (for example `cargo run --release -p delulu-dictation
--example bench`) on clean speech before and after. If whisper.cpp no longer
compiles against the new ggml, move whisper-rs-sys to the release whose whisper.cpp
synced ggml in the same week as the llama.cpp pin, and re-apply the patch.

## transcribe.cpp v0.4.2: Parakeet Ultra on the same ggml

`vendor/transcribe.cpp` holds the files of
[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT,
handy-computer) at `275cd50` (v0.4.2) that its library needs: `CMakeLists.txt`,
`cmake/`, `include/`, `src/` (with miniz and Silero VAD, MIT), `LICENSE` and
`THIRD-PARTY-LICENSES.md`. Its own ggml, tests, examples and bindings are left out.
`crates/transcribe` builds it and wraps the few calls `delulu-engine stt` makes.

transcribe.cpp pins ggml-org/ggml `d7cb574` (0.26.0) plus four downstream patches.
Apart from those patches, that ggml is the one llama-cpp-sys-2 0.1.160 builds, so
the library is built against the engine's ggml like whisper.cpp. `transcribe.cpp.patch`:

- `TRANSCRIBE_USE_SYSTEM_GGML` makes CMake use an installed ggml (`find_package`)
  instead of the vendored copy;
- with `TRANSCRIBE_SHARED_GGML`, `src/transcribe.cpp` does not install its backend
  registry filter, which needs ggml patch 0002. Every compiled-in backend then
  registers, which is what its default (all backends) does anyway. Patches 0001
  (CPU threadpool oversubscription), 0003 (Metal) and 0004 (an x86 check for
  loadable CPU backends) are performance or platform fixes the engine does without.

`crates/transcribe/shared-ggml.cmake` compiles it with the engine's `GGML_MAX_NAME`
and adds the same `struct ggml_tensor` probe as for whisper.cpp; the test
`transcribe_and_the_linked_ggml_agree_on_tensor_layout` and every model load check
it. On spike E1's 860 clips, Parakeet Ultra built this way gave the same text as
transcribe.cpp's official binary with its own ggml, clip for clip.

```sh
vendor/transcribe.cpp.sh verify   # upstream + patch == vendor/transcribe.cpp
vendor/transcribe.cpp.sh diff     # rewrite the patch after editing the vendored tree
```
