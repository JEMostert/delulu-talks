# Native window rendering review — v0.12.2

## Diagnosis

The running v0.12.1 AppImage explicitly disabled Chromium GPU drawing on Linux Wayland. Its renderer had `--disable-gpu-compositing` and its compositor had `--use-gl=disabled`. Three one-second CPU samples from the already running app showed compositor usage of 30%, 34% and 33%, while the renderer used 1%, 2% and 1%. This points to drawing cost rather than a continuously busy React thread; it does not establish a measured input-to-paint latency.

The animated ocean includes viewport-sized gradients, masks and blending. Although v0.12.1 stepped software animations less frequently, every step still required drawing those large layers. The nearly full-window workspace sheet also used a 20px backdrop blur. Browser preview checks from the previous release did not reproduce this native software compositing path.

## Changes

- Remove the unconditional Wayland GPU disable switch. Chromium can select hardware acceleration using its normal driver support checks.
- Keep `DELULU_SOFTWARE_RENDERING=1` as an explicit driver workaround, calling `app.disableHardwareAcceleration()` before readiness.
- Expose the `gpu_compositing` feature status through the existing validated IPC/preload boundary. Use conservative software styling until status is known and update it on `gpu-info-update`. [Electron documents these feature values](https://www.electronjs.org/docs/latest/api/structures/gpu-feature-status/); [hardware acceleration must be disabled before readiness](https://www.electronjs.org/docs/latest/api/app#appdisablehardwareacceleration).
- Replace the renderer's WebGL probe and software stepping timers with a static ocean in software mode. Disable backdrop filters in that mode. Keep functional recording feedback separate from decoration.
- Pause all decorative ocean animations behind workspace and quick settings panels; remove the large workspace blur while retaining the small quick sheet's glass effect under hardware compositing.
- Suppress large voice-glow writes behind panels and during software compositing. Ripple input uses current panel visibility without clearing pending cleanup timers on panel changes.

## Native verification

Use a private Computer Artist KWin Wayland desktop at 1280 × 800, with an 800 × 620 application window. Launch the installed v0.12.1 executable with a separate `DELULU_USER_DATA_DIR` and `DELULU_SMOKE_TEST=1`, then stop that test instance and launch the changed production build using the same Electron version and another isolated profile. Force native Wayland with `--ozone-platform=wayland`. The actual user's app and loaded speech worker stay running.

CPU percentages use psutil process samples, where 100% is one logical core. These observations are short samples on one machine:

| State                                              | Compositor CPU | Renderer CPU | Sample                     |
| -------------------------------------------------- | -------------: | -----------: | -------------------------- |
| v0.12.1, Models open                               |     7%, 7%, 7% |   0%, 1%, 0% | Three one-second intervals |
| v0.12.1, Home                                      |            21% |           3% | One three-second interval  |
| Changed build, Models open                         |           0.7% |           0% | One three-second interval  |
| Changed build, explicit software mode, Models open |             0% |           0% | One three-second interval  |

Opening Editor and typing physical keys produced the complete `hello` draft. Opening Settings and scrolling moved its content to the Theme and Launch at login controls. Native captures confirmed the transitions. The explicit software launch reported `gpu_compositing: disabled_software` and `isHardwareAccelerationEnabled(): false` through read-only main-process inspection.

Browser preview inspection confirmed paused ocean animations behind a workspace, no large-sheet backdrop blur, and disabled backdrop filters under software styling. Browser preview uses sample services; it does not establish native compositor behavior.

## Limits

The open Home ocean still animates under hardware compositing and continues to consume rendering resources. The private desktop's changed Home samples did not establish an idle CPU improvement. The reliable measured reduction is while workspaces are open and in software fallback.

No percentile latency benchmark, active model inference benchmark, recording-to-paste measurement or native macOS/Windows GUI check was performed here. Native input and rendering observations supplement the existing unit, type, formatting and build checks. Release CI verifies all platform packages and updater checksums.
