# delulu-music-ace

ACE-Step 1.5 Turbo (2B, default) and XL Turbo (4B) for Delulu FM. It wraps [acestep.cpp](https://github.com/ServeurpersoCom/acestep.cpp)
(MIT) instead of porting it: `build.rs` compiles its core library and `src/shim.cpp`
into the engine, linked against the one ggml that llama-cpp-sys-2 builds.

```sh
echo '{"engine":"acestep","style":"English, synth-pop, 112 BPM, female vocal",
       "lyrics":"[Verse]\nThe last train hums beneath the street","seed":1,
       "seconds":60,"language":"en","lm":"auto"}' |
  delulu-engine music generate --models ~/.local/share/delulu-talks/models --out song.wav
```

Set `"xl":true` for XL Turbo. Its generator bundle lives in `<models>/ace-step-1.5-xl/`. Both generators read the planner from `<models>/ace-step-1.5/`.

Request fields: `style` (the caption, sent as written), `lyrics` (section tags such
as `[Verse]`), `seed`, `seconds` (10–600; ACE delivers exactly this length), and
optionally `bpm`, `language` (pin it: it keeps Dutch songs Dutch), `instrumental`
(the lyrics become `[Instrumental]`) and `lm` (`auto`, `0.6b` or `4b`; auto takes
the 4B model with at least 8 GiB of free graphics memory). The files come from
the registry rows `ace-step-1.5-turbo`, `ace-step-1.5-lm-0.6b` and
`ace-step-1.5-lm-4b` in `crates/models`, in `<models>/ace-step-1.5/`.

Guards from the bake-off (spike E4): the LM's KV cache is sized to the prompt plus
every code (acestep.cpp silently computes nothing past it), the VAE decodes in
512-frame tiles or 256 below 5 GiB free (never the default 1024, which needs about
9 GiB), the LM may not end before `seconds × 5` codes, and a song with fewer codes
or less than 90% of its length is an error. The LM is freed before synthesis, so
the peak is the larger stage. Tested on NVIDIA (Vulkan) only; an AMD integrated
GPU hit the amdgpu compute timeout in the spike.

## One ggml, one `GGML_MAX_NAME`

acestep.cpp's DiT tensor names are longer than ggml's default 64 characters, and
`GGML_MAX_NAME` changes `struct ggml_tensor`. `.cargo/config.toml` sets it once:
llama-cpp-sys-2 passes it to CMake (and rebuilds when it changes), `ggml.cmake`
turns it into a compile definition for the whole llama.cpp project, and `build.rs`
compiles acestep.cpp with the same value. The test
`acestep_and_the_linked_ggml_agree_on_tensor_layout` fails on a mismatch, for
example a build directory from before this setting: `cargo clean -p
llama-cpp-sys-2` fixes it. whisper.cpp (the `stt` role) links the same ggml and is
compiled with the same value (`vendor/whisper-rs-sys/shared-ggml.cmake`); its test
`whisper_and_the_linked_ggml_agree_on_tensor_layout` checks that the same way.

## Vendored acestep.cpp

`vendor/acestep.cpp` holds the files the core library needs (`LICENSE`, `src/`,
`vendor/yyjson/`) from upstream revision
`603e68284c34cebb8485dbb4b8cb2549f9cded56`, byte for byte, plus the patches in
`patches/`:

- `0001-minimum-code-count.patch`: when the LM draws its end token before
  `duration × 5` codes, it draws again from the same logits without it. A song
  that would not stop early samples exactly as upstream. (The spike's 1.7B LM
  stopped after 1–126 s on 11 of 12 songs; the radio cannot hear every song.)

- `0002-macos-float-parser.patch` selects the portable float parser on Apple platforms so the engine runs on macOS 15.

Check the tree against upstream:

```sh
crates/music-ace/vendor.sh verify
```

To update: `crates/music-ace/vendor.sh update <revision>`, set `REV` in
`vendor.sh`, fix any patch that no longer applies, and then, because acestep.cpp is
pinned to a revision tested against the app's ggml rather than its own ggml fork:
build the engine, run the music-ace tests, and rerun the 12-song check (spike E4's
`songs.json` through `delulu-engine music` with LM 4B and 0.6B, Whisper word
recall not worse than before). Do the same after every llama-cpp-sys-2 (ggml) bump.

Licences: acestep.cpp MIT (© The acestep.cpp authors), yyjson MIT (© YaoYuan);
both notices are in the vendored files.
