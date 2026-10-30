# Optional spoken replies: local verification

Verified on Linux / PipeWire / NVIDIA CUDA, 2026-10-30. CLI installed at
`/home/boran/.local/bin/delulu`. Implementation was subsequently prepared for the authorized v1.3.0 release.

## CLI journeys

- Release build, CLI clippy with warnings denied, Tauri `cargo check`, frontend
  typecheck and production frontend build passed.
- Setup installed the binary, configuration and `delulu-speak` skills. Repeating
  setup reuses the environment and cached model revision. Existing microphone,
  dictation, listening skills and shared services were not changed.
- Fresh setup with an empty isolated Hugging Face cache and both `HF_HUB_OFFLINE=1`
  and `UV_OFFLINE=1` succeeded: status was `configured: true, ready: false`.
  Speaking failed with explicit `delulu install-model` guidance and produced no
  WAV or weights. Setup never opts into a model download.
- A partial cached snapshot containing weights but no tokenizer assets was
  rejected as not ready. Repeated offline setup did not attempt a download.
- Repeated setup preserved a configured CPU device and voice reference;
  `--default-voice` explicitly cleared the reference while preserving the device.
- Explicit `install-model` reused the existing snapshot without duplicate weights.
- Real default-speaker Turbo generation saved `/tmp/delulu-turbo-verification.wav`:
  24,000 Hz, mono, 43,200 samples (1.8 seconds), finite and non-silent,
  peak amplitude 0.2681. No playback occurred on the `--output` path.
- A separate stdin invocation generated 1.32 seconds of speech and completed real
  PipeWire `pw-play --volume 0` playback successfully. Only that stream was muted;
  no desktop/system/other-tab volume was changed. Normal CLI volume remains 1.
- SIGTERM while waiting for stdin returned 143. Two invocations queued behind
  the speech lock and both cancelled with SIGINT / exit 130 without synthesis.
  SIGTERM during an active synthesis invocation returned 143 and reaped its
  Python child, leaving no output or playback.
- The one-shot Python process exited before playback. GPU process inspection
  after generation showed no Delulu TTS worker. Existing app, cleanup, Unsloth and
  other GPU processes continued running.
- The skill passed `skill-creator/scripts/quick_validate.py`.

## GUI journeys

GPT-6.1 Terra manually verified the browser-rendered Settings using the app's
mock IPC backend: optional/not-installed state, explicit Install model action,
Installing state, Ready state, installation error and retry, and a narrow
640×800 viewport. Existing CSS, typography, colors and row/button components are
reused; there are no stylesheet changes. Opening Settings invokes status only.
The native debug Tauri app was subsequently exercised in a private Computer Artist
KWin desktop with actual IPC and the installed CLI: Model not installed →
Installing → Ready, and Ready persisted after closing and reopening. Settings/Input
also rendered normally; microphone interaction was deliberately excluded. All
model installation checks were offline against existing cached weights.
An initial missing-revision fixture exposed an unnecessary online revision lookup;
the final installer resolves a cached revision locally before querying the hub.

The private desktop initially failed because its control socket was absent and the
installed plugin reported a KWin version mismatch. The verification delegate used
a task-local plugin build in `/tmp` and socket readiness handling to start its
private desktop; no shared desktop was restarted.

Screenshots from the verification session:

- Optional model: `/home/boran/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvvdoj8p-d428281f.png`
- Installation error: `/home/boran/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvvdp9vy-0e92097b.png`
- Narrow layout: `/home/boran/.t3/userdata/browser-artifacts/browser-screenshot-127-0-0-1-mvvdmfg6-c3b481f3.png`

## Runtime and download history

The shared Flash Python/CUDA environment is reused without modifying it. The
Turbo API is supplied by installed `chatterbox-tts` 0.1.7. A private 5.6 MB
setuptools 80.9.0 overlay supplies `pkg_resources` required by Perth watermarking.
Turbo uses its own official weights and bundled default speaker, never the Flash
reference. Model revision: `749d1c1a46eb10492095d68fbcf55691ccf137cd`.

Before the optional-install steering arrived, the earlier setup verification
had already cached 4,044,165,216 bytes from the official model repository,
including 1,056,484,620 bytes of unused `s3gen.safetensors`. These shared cache
assets were retained. The final installer restricts downloads to the required
2,987,680,596 bytes (about 3 GB); it does not download that unused weight.

Current limitations: Linux and PipeWire playback; an existing compatible Python
TTS environment is required (`--python` selects it); CUDA by default, optional
CPU; English Turbo speech. Speech jobs serialize with one another, not unrelated
GPU applications. Startup loads the model anew each time. No audible listening
quality assessment was performed, by request. A hard SIGKILL may leave a private
temporary directory, but the inference child receives a parent-death signal.

Native screenshots:

- Not installed: `/home/boran/.local/state/computer-artist/environments/voice-ipc-check/output/2026-10-30_19-53-58-537902Z-d68fb9/captures/app/fa5c2db5600943838a08d177c156eb02.png`
- Installing: `/home/boran/.local/state/computer-artist/environments/voice-ipc-check/output/2026-10-30_19-54-03-503513Z-a47779/captures/app/4d583c0c85a649f7b200adf714c73770.png`
- Ready after reopening: `/home/boran/.local/state/computer-artist/environments/voice-ipc-check/output/2026-10-30_19-54-37-868414Z-3e5b83/captures/app/5bdd2dcd23f84c0dbe0b143ce42c7ca1.png`

Final offline cache journeys passed using an isolated cache containing only the
nine required files and the actual upstream tree metadata: explicit installation
with `revision: null` succeeded both with and without `refs/main`; lightweight
setup reused the same snapshot without `refs/main`. No assets were downloaded.
Cross-review completed three rounds with GPT-6.1 Sol high: APPROVE. C1 (cache
probe included unused upstream files) is resolved; no Broken or Medium findings
remain.
