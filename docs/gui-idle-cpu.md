# Quiet GUI during idle capture

The hardware-rendered Home ocean in v0.12.2 continues its decorative CSS
animations between recordings. Also, `document.hidden` does not reflect a hidden
Electron window when `backgroundThrottling: false` keeps microphone capture alive.

This change pauses ocean decoration whenever capture is idle or paused, a
workspace covers the ocean, or the native window is hidden or minimized. The
voice-glow interval is created only for visible, uncovered recording. Pointer
ripples use the same activity gate. Theme changes and normal controls remain
available. Microphone capture keeps its existing background behavior.

The main process publishes window visibility on show, hide, minimize, restore,
and renderer load. A validated no-argument IPC request supplies the initial
value; the renderer subscribes before requesting it and ignores a stale initial
response once an event has arrived. Browser preview supplies the same API using
document visibility.

The workspace scroll area uses native smooth scrolling and a separate composited
container with layout/paint containment. Existing reduced-motion styles retain
instant scrolling. v0.12.2's hardware/software rendering selection is preserved.

## Verification

Checked against `main` at `ef4f7e1`, using Electron 43.3.0 on KDE Wayland / Intel
Arc. A native Electron instance loaded the production build with an isolated
profile and `DELULU_SMOKE_TEST=1`, no speech preloading, and
`--ozone-platform=wayland`. CPU percentages below use `/proc/<pid>/stat` user and
system tick differences over five seconds; 100% represents one logical core.

| Scene                              | Main CPU | Graphics-process CPU | Renderer CPU |
| ---------------------------------- | -------: | -------------------: | -----------: |
| Home, idle                         |     0.0% |                 0.0% |         0.0% |
| Hidden, simulated listening status |     0.2% |                 0.4% |         0.4% |
| Settings, idle                     |     0.0% |                 0.0% |         0.2% |

The native test verified hardware rendering, running animations during a
simulated listening status, and all 18 ocean CSS animations paused after hiding.
At that point `document.hidden` was still false while the native visibility API
returned false. Showing the window resumed animation. Settings wheel input
moved the scroll position from 0 to 173 pixels.

The native status simulation verifies rendering and window visibility, not
speech inference or physical microphone capture. These short measurements on
one machine are not a universal utilization or display-latency guarantee.

Automated checks:

- `bun run build` (including renderer and Electron type checks).
- `bun run format:check`.
- `bun run test:unit`: 70 tests pass.
- `bun run test:python`: 19 tests pass.
- `bun run test:e2e`: five tests pass. Three new checks verify paused CSS animation
  timelines in idle/pause/cancel, recording resume, hidden decoration without
  changing recording state, workspace coverage, and reduced-motion scrolling.
  Two existing checks use Chromium's real fake microphone and AudioWorklet to
  verify final PCM delivery and repeated cancel/release behavior.
