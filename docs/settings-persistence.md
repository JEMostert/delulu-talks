# Settings persistence

Settings and saved history use private temporary files and atomic publication. Durable writes finish before memory changes; write failures preserve the previous saved and in-memory profile. Both input files are validated before startup migration can replace either one. An unchanged profile avoids rewriting its settings on every startup.

```sh
bun test electron/services/storage.test.ts
```

The rebuilt unit suite checks corrupt and future profiles, failed atomic publication and temporary-file cleanup, failed settings/transcript updates with intentional retry, history ownership, and private results staying unsaved after persistence is re-enabled. It uses small isolated profiles and injected failure boundaries, without Electron or subprocess mocks.

The former settings/desktop integration test commands are no longer part of this project. See [testing](VERIFICATION.md) for current commands and evidence limits.
