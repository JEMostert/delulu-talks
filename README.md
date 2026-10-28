# Delulu Talks

Local push-to-talk dictation for Linux. Install the rpm on Fedora or the pacman package on Arch from a release.

Text cleanup is on by default. After each dictation, a small model that runs on your own computer removes filler words and adds punctuation, in Dutch and English. The model is a one-time 5.2 GB download that runs in the background after first start. To turn cleanup off, use the Clean up text switch in Settings → Dictation.

Development requires Rust, Bun, GTK/WebKitGTK development libraries, ALSA, Vulkan headers, glslc, SPIRV-Headers and clang. Run `bun install && bun run build:helper && bun run dev`; the helper build is needed for text cleanup and `tauri dev` does not build it. On Fedora, if clang cannot find its headers, set `BINDGEN_EXTRA_CLANG_ARGS` to the GCC include directory. The v1 skeleton currently uses stub implementations.
