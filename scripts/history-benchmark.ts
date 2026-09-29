/** Opt-in Electron main-process benchmark; never import from the application. */
import { app } from "electron";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StorageService } from "../electron/services/storage";
import { DEFAULT_SETTINGS } from "../src/data";
import { EMPTY_HISTORY_FILTERS, filterHistory } from "../src/historyFilters";
import { sortHistory } from "../src/historyView";
import type { TranscriptRecord } from "../src/types";

if (process.env.DELULU_HISTORY_BENCHMARK !== "1") {
  console.error("Explicit opt-in required: DELULU_HISTORY_BENCHMARK=1");
  app.exit(2);
} else {
  app.disableHardwareAcceleration();
  const root = mkdtempSync(join(tmpdir(), "delulu-history-benchmark-"));
  // All Electron profile/cache/legacy lookup paths belong to this disposable run.
  for (const name of ["home", "appData", "userData", "sessionData"] as const) {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath(name, directory);
  }
  const results: Record<string, unknown>[] = [];
  function timed<T>(operation: () => T): { value: T; ms: number } {
    const start = performance.now();
    const value = operation();
    return { value, ms: performance.now() - start };
  }
  function records(size: number): TranscriptRecord[] {
    return Array.from({ length: size }, (_, index) => ({
      id: `synthetic-${index}`, createdAt: 1_700_000_000_000 + index * 60_000,
      durationMs: 30_000 + index % 120 * 1000,
      text: `${index % 2 ? "De afspraak is dinsdag. Controleer de bestandsnaam" : "The meeting is Tuesday. Review the file name"} report_${index}.ts ${"Synthetic consent-free benchmark text. ".repeat(12)}`,
      editedText: index % 7 === 0 ? `Correction for report_${index}.ts` : null,
      magicText: index % 11 === 0 ? `Rewritten synthetic meeting ${index}` : null,
      magicModel: index % 11 === 0 ? "qwen35Small" : null,
      magicPreset: index % 11 === 0 ? "polish" : null,
      magicIncludedInferences: false, magicProcessingTimeMs: 0,
      model: index % 3 ? "r2t2" : "r2t2Mlx", language: index % 2 ? "nl" : "en",
      source: index % 5 ? "dictation" : "file", sourceName: index % 5 ? null : `meeting_${index}.wav`,
      processingTimeMs: 1500, sourceRevision: 0, rewriteSourceRevision: null,
    }));
  }
  void app.whenReady().then(() => {
    try {
      for (const size of [500, 10_000, 50_000]) {
        const input = records(size);
        for (let repeat = 0; repeat < 3; repeat += 1) {
          const measurements: Record<string, unknown> = { inputRecords: size, repeat };
          for (const query of ["meeting", "report_499.ts", "no-such-phrase", "afspraak"]) {
            const search = timed(() => filterHistory(input, { ...EMPTY_HISTORY_FILTERS, query }));
            measurements[`syntheticFullSearch:${query}`] = { ms: search.ms, matches: search.value.length };
          }
          measurements.syntheticFullSortMs = timed(() => sortHistory(input, "oldest")).ms;
          const selected = input.filter((_, index) => index % 10 === 0);
          const exported = timed(() => JSON.stringify(selected));
          measurements.syntheticSelectedJsonExport = { ms: exported.ms, selected: selected.length, bytes: Buffer.byteLength(exported.value) };
          for (const migration of [false, true]) {
            const directory = join(root, `size-${size}-repeat-${repeat}-${migration ? "legacy" : "current"}`);
            mkdirSync(directory, { mode: 0o700 });
            app.setPath("userData", directory);
            const settings = migration ? { ...DEFAULT_SETTINGS, workflowVersion: undefined } : DEFAULT_SETTINGS;
            const fixture = migration ? input.map(({ text, ...record }) => ({ ...record, intendedText: text })) : input;
            writeFileSync(join(directory, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
            writeFileSync(join(directory, "history.json"), JSON.stringify(fixture), { mode: 0o600 });
            const before = process.memoryUsage();
            const initial = timed(() => new StorageService());
            const loaded = initial.value.getHistory();
            const loadedSearch = timed(() => filterHistory(loaded, { ...EMPTY_HISTORY_FILTERS, query: "meeting" }));
            const reload = timed(() => new StorageService());
            const ids = loaded.slice(0, Math.min(100, loaded.length)).map((record) => record.id);
            const deletion = timed(() => { for (const id of ids) initial.value.deleteHistory(id); });
            measurements[migration ? "legacyMigration" : "currentStartup"] = {
              constructorMs: initial.ms, normalizedReloadMs: reload.ms,
              retainedRecords: loaded.length, truncatedRecords: size - loaded.length,
              retainedSearchMs: loadedSearch.ms, retainedMatches: loadedSearch.value.length,
              serialDeleteCount: ids.length, serialDeleteMs: deletion.ms,
              heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed,
              rssBytes: process.memoryUsage().rss,
            };
          }
          results.push(measurements);
        }
      }
      console.log(JSON.stringify({
        schemaVersion: 1, generatedAt: new Date().toISOString(),
        environment: { platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, cpu: cpus()[0]?.model },
        limitations: ["Synthetic text only; no personal data", "Main-process constructor timings exclude Electron launch and renderer rendering", "OS page cache is not reset; normalized reload is not a cold disk measurement", "Full synthetic search is separate from retained application history", "Storage retention/truncation is reported explicitly", "Deletion measures existing serial writes, not a future batch API", "Memory deltas include GC noise; no forced GC or GPU measurement", "No migration/retention policy change is authorized by this report"],
        results,
      }, null, 2));
    } catch (reason) {
      console.error(reason instanceof Error ? reason.stack : String(reason));
      process.exitCode = 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
      app.exit(process.exitCode ?? 0);
    }
  }).catch((reason) => {
    console.error(String(reason));
    rmSync(root, { recursive: true, force: true });
    app.exit(1);
  });
}
