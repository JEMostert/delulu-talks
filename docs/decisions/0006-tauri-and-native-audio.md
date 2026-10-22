# ADR 0006: Tauri shell, Rust backend and native audio

Status: accepted; shipped in v0.1.0. Recorded 22 October 2026. Linux/Wayland is the reference platform; macOS is built in CI but not yet run on native hardware. Windows is not supported.

## Context

The Electron app bundled Chromium and Node for a tray utility whose heavy work already ran in Python workers. Packages were large, the main process (`electron/main.ts` and its services) had grown crowded, and voice agents needed Node or `ELECTRON_RUN_AS_NODE` to run the MCP script. Native Linux packages beyond AppImage and pacman were missing.

Moving to Tauri means the renderer runs in the system webview. A Phase 0 probe showed WebKitGTK 2.52 runs the UI fine (`color-mix`, `:has`, `backdrop-filter`, `dvh`, `@layer`, `<dialog>`, module workers, gesture-free AudioContext all pass; raw binary IPC round-trips 8 MiB in about 80 ms), but it only starts `getUserMedia` for a focused window (`GetUserMediaRequiresFocus`), and with that check disabled it hangs every request after the first while unfocused. Dictation always records while another app has focus, so renderer capture as in ADR 0001 cannot work there.

## Decision

- **Tauri 2 with a full Rust backend.** Every Electron main-process module and every shared `src/` module it imported is ported to Rust crates under `src-tauri/crates/` (`delulu-core`, `-domain`, `-runtime`, `-audio`, `-desktop`, `-data`, `-speech`, `-voice`) plus the app crate `src-tauri/src`. Leaf crates depend only on `delulu-core`; app integrations are traits the app crate implements. See the [architecture layout](../ARCHITECTURE.md#layout).
- **Renderer unchanged except the bridge.** `src/desktopBridge.ts` installs the same `window.delulu` API over three commands (`ipc_invoke`, `ipc_send`, `ipc_bytes`) with the Electron channel names and result envelope; events keep the Electron channel names. Rust validates every request again with the same limits.
- **Native audio.** Capture, levels, trailing silence, cues, listening voice-activity detection and voice playback move to `delulu-audio` on cpal (through handy-cpal): the PulseAudio host on Linux (pipewire-pulse on PipeWire systems) with an ALSA fallback, CoreAudio, WASAPI. The renderer only displays state, and WebKitGTK media capture stays disabled. This also removes the large WAV and PCM transfers over IPC.
- **Compatibility over redesign.** Wire types serialize exactly like the TypeScript types, errors keep their codes and wording, and the profile stays where it was (`Delulu Talks`, `Delulu Talks Dev`, `DELULU_USER_DATA_DIR`), with persisted JSON read and written byte-for-byte like Electron did. Python workers and the GTK4 overlay are unchanged, moved to `backend/python` and `backend/overlay`.
- **CLI subcommands instead of scripts.** The voice MCP server is `delulu-talks mcp` and profile recovery is `delulu-talks restore-profile`.
- **Packaging.** AppImage (self-updating), deb, rpm (Fedora), pacman `delulu-talks-bin` (CachyOS/Arch, repackaged from the deb in CI), macOS arm64 dmg with updater archive. Updates use tauri-plugin-updater with a signed `latest.json`; deb, rpm and pacman update through the package manager. Release numbers restart at v0.1.0 and the Electron releases are removed.

## Consequences and alternatives

- Listening mode loses Chromium's WebRTC echo cancellation. Barge-in relies on the echo gate (the playback level as reference) and the recent-speech transcript filter; headphones remain the reliable setup. A native echo canceller is future work.
- Linux portal identity needs an installed `delulu-talks.desktop`; development builds write one to `~/.local/share/applications` if none exists. GNOME has no layer-shell, so the overlay is unavailable there (KDE works), and no data-control, so the clipboard goes through X11 via Xwayland.
- The native inference harness, the Mac lifecycle driver, the cold-start speech benchmark and the history benchmark were Electron scripts and are not ported yet.
- macOS behaviour (webview, CoreAudio capture, updater) is untested on real hardware. Windows is no longer built or supported.
- Rejected: keeping renderer capture with the focus requirement disabled (WebKitGTK hangs every unfocused request after the first), and changing the profile format during the port (it would strand existing profiles and backups).

This supersedes the capture-ownership part of [ADR 0001](0001-buffered-capture-and-worker-transport.md) and the packaging mechanism of [ADR 0003](0003-isolated-runtime-generations.md); their other decisions stand.
