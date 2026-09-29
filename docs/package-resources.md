# Packaged resource verification

`bun run test:package-resources -- <unpacked-directory-or-app> <linux|mac|win>` checks actual artifact files against the current checkout. Use the same revision to build and verify: a stale adapter or constraint intentionally fails its SHA-256 comparison. The command is read-only and reports fixture-only evidence; it does not start models or certify native application behavior.

The verifier requires the worker, Linux speech adapter, direct MLX adapter, Windows native adapter and strict checkpoint converter; the Linux constraints, model/framework notices and bundled Transformers license; the overlay helper; and the app/tray/retina-template PNGs. It rejects missing, empty, misrouted or duplicate required resource mappings. Every declared external resource must be present and byte-identical in the artifact, including additions beyond the current thirteen files.

Native icon checks validate the configured PNG/ICNS/ICO sources and the exact 2x macOS tray-template dimensions. Linux's packaged PNG must match its configured native icon. A Mac bundle's Info.plist must reference the configured ICNS bytes and a present executable. A Windows executable must contain every configured ICO image payload; merely shipping an unused .ico beside the executable does not pass. These are content checks, not a claim about launcher appearance or native menu-bar rendering.

Build and verify unpacked artifacts without publishing:

```sh
bun run build
bunx --no-install electron-builder --dir --linux --x64 --publish never
bun run test:package-resources -- release/linux-unpacked linux
bunx --no-install electron-builder --dir --mac --arm64 --publish never
bun run test:package-resources -- 'release/mac-arm64/Delulu Talks.app' mac
bunx --no-install electron-builder --dir --win --x64 --publish never
bun run test:package-resources -- release/win-unpacked win
```

Linux CI builds an unpacked artifact, runs the resource audit, then launches it through the existing isolated Electron fixture smoke. Both reports retain native-inference and manual-desktop as not-run. The fixture uses a temporary profile and synthetic Web Audio; it does not access personal settings/history/model environments.

This change was checked against actual Linux x64, cross-built Apple Silicon arm64 and Windows x64 unpacked artifacts on Linux, including the Mac ICNS reference and Windows embedded ICO payloads. Windows resource editing used Wine with an isolated temporary prefix. The Linux packaged application passed real Electron/preload/IPC/persistence/production-CSP worklet checks. Cross-built Mac/Windows content verification establishes their artifact contents only: native launch, microphone permissions, inference, code signing, installers, updates and visual icon quality remain separate platform gates.

`bun test scripts/package-resources.test.mjs` uses copies in owned temporary directories. It deliberately removes/stales packaged adapters, replaces the Mac icon, removes Windows icon payloads, and corrupts required mappings/native icon sources. These cases fail without modifying the inspected artifact. Actual signing and hardware inference are never substituted by those fixtures.
