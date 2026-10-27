# Packaged resource verification

`bun scripts/package-resources.mjs <src-tauri/target> <linux-x64|mac-arm64>` checks a Tauri build's bundled resources against the current checkout. It reads `bundle.resources` from `src-tauri/tauri.conf.json`, finds the bundled resource directory (the deb tree on Linux, `Contents/Resources` in the Mac app) and requires every declared resource to be present and byte-identical (SHA-256). Use the same revision to build and verify: a stale adapter or constraint intentionally fails. The command is read-only; it does not start models or certify native application behavior.

It also rejects duplicate destinations, missing sources and a configuration without the required resources: the worker and protocol, the Pilot worker, the CPU speech adapter, the voice engine, the Linux constraints, the overlay helper, the agent skill, the app icon and the idle/recording tray icons. All 45 declared resources (Python workers, notices and Transformers license, overlay, skill, app and tray icons) are compared.

Build and verify without publishing:

```sh
bun run build
bun scripts/package-resources.mjs src-tauri/target linux-x64
```

The release workflow runs the same check on each platform's build (`linux-x64`, `mac-arm64`) before the draft release is published.

Content verification of the Mac build establishes its artifact contents only: native launch, microphone permissions, inference, code signing, updates and visual icon quality remain separate platform gates.
