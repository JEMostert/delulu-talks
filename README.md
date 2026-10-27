# Delulu Talks

Local push-to-talk dictation for Linux. Install the rpm on Fedora or the pacman package on Arch from a release.

Development requires Rust, Bun, GTK/WebKitGTK development libraries, ALSA, Vulkan headers, glslc and clang. Run `bun install && bun run dev`. On Fedora, if clang cannot find its headers, set `BINDGEN_EXTRA_CLANG_ARGS` to the GCC include directory. The v1 skeleton currently uses stub implementations.
