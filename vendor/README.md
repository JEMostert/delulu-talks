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
