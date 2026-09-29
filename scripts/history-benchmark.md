# Opt-in history benchmark

This runner uses the real Electron `StorageService`, migration/backup writes, renderer search/filter and sorting functions. It generates 500, 10,000 and 50,000 synthetic records, repeats each workload three times, and reports both input size and retained size. Current retention may truncate to 500; full synthetic search timings never imply that the application retained every record. It also times selected JSON serialization and the current serial deletion API.

Run explicitly from the repository when benchmark execution is authorized:

```sh
bun build scripts/history-benchmark.ts --target=node --format=cjs --external=electron --outfile=/tmp/delulu-history-benchmark.cjs
DELULU_HISTORY_BENCHMARK=1 bunx electron /tmp/delulu-history-benchmark.cjs > history-benchmark-report.json
```

The bundle contains the checked-out implementation. Record its Git SHA with the report. Use your installed repository Electron binary if avoiding `bunx` package resolution. A functioning desktop environment may be required. No model is loaded, no original history is read, and all profile/cache/home paths are redirected to a uniquely created temporary directory before storage initialization. Only that owned directory is removed after execution.

Compare repeated reports on the same machine and revision before deciding on pagination, batch writes or SQLite. Constructor timing excludes Electron launch, renderer rendering and page-cache reset. Memory deltas include garbage-collection noise. The runner does not assert a performance target or automatically change the retention policy. It has not been run under the current no-checks instruction.
