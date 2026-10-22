# Linux rendering

The AppImage bundles the Ubuntu 22.04 build environment's GTK and WebKitGTK.
On CachyOS / KDE Wayland with NVIDIA, its WebKitGTK 2.50.4 repainted the
animated ocean on the main thread: roughly 3–5 fps with one CPU core busy.
System WebKitGTK 2.54.1 sustained 60 fps in the same private 60 Hz desktop.
Disabling DMA-BUF or forcing compositing did not resolve the bundled build's
slow rendering.

At GUI startup, the AppImage probes the system libraries by running its own
binary with `--print-webkit-version` and a cleaned host environment. Only a
successful probe reporting a newer version causes a re-exec, before GTK,
threads or single-instance registration start. The re-exec preserves command
arguments and the AppImage identity used by resources, updates and launcher
integration. WebKit helpers then inherit the host environment. A missing,
incompatible or older system stack leaves the bundle in use.

`DELULU_BUNDLED_WEBKIT=1` skips the system probe. Startup logs report a switch
and the loaded version. `--print-webkit-version` reports the initially loaded
library without starting the GUI or switching libraries.

On NVIDIA Wayland, startup defaults `__NV_DISABLE_EXPLICIT_SYNC=1` before GTK
initialization. This avoids KWin disconnecting the app with “explicit sync is
used, but no acquire point is set” / Gdk Error 71. Hardware compositing stays
enabled, and an explicitly supplied value takes precedence.

Verification used `bun run dev`, followed by the new debug binary installed
in a temporary extracted copy of the released AppImage and launched through
its original AppRun wrapper. A temporary rAF probe forced the ocean animations
to stay active. The wrapper switched from 2.50.4 to 2.54.1 and sustained 60 fps
(p95 18–19 ms after startup). The probe is removed from shipped assets.
