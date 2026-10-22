// Regenerates the Electron-written profile fixtures with the TypeScript
// StorageService at d463db9 (the last Electron release of storage.ts):
//
//   rm -rf /tmp/delulu-ts && mkdir -p /tmp/delulu-ts
//   git archive d463db9 electron src | tar -x -C /tmp/delulu-ts
//   mkdir -p /tmp/delulu-ts/node_modules/electron
//   echo 'module.exports = { app: {} };' > /tmp/delulu-ts/node_modules/electron/index.js
//   cp src-tauri/crates/delulu-data/tests/fixtures/generate.ts /tmp/delulu-ts/
//   cd /tmp/delulu-ts && bun generate.ts <fixtures directory>
//
// `current/` is a profile the Electron app saved (opened, settings updated,
// transcripts added) and must reopen unchanged. `legacy/` holds an
// unversioned pre-release profile (`input/`) and the files the Electron app
// migrated it to (`migrated/`).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "./src/data";
import { StorageService } from "./electron/services/storage";

const out = process.argv[2];
const app = (directory: string) => ({ isPackaged: false, getPath: () => directory });
const copy = (from: string, to: string) => {
  mkdirSync(to, { recursive: true });
  for (const name of ["settings.json", "history.json"])
    writeFileSync(join(to, name), readFileSync(join(from, name)));
};

// A current profile written by the Electron app.
const current = mkdtempSync(join(tmpdir(), "delulu-fixture-"));
const storage = new StorageService(app(current) as never);
storage.updateSettings({
  ...DEFAULT_SETTINGS,
  ...storage.getSettings(),
  onboardingComplete: true,
  language: "auto",
  captureSoundVolume: 0.35,
  trailingSilenceSeconds: 7.5,
  historyRetention: { maxAgeDays: 30, maxCount: null },
  wordPacks: ["programming"],
  customWords: [
    { id: "w1", term: "Delulu", soundsLike: "delulu", replacement: "", enabled: true, aliases: ["de lulu"] },
    { id: "w2", kind: "shortcut", term: "sig", language: "NL", soundsLike: "", replacement: "\tGroet,\r\n  Boran  ", enabled: true },
  ],
  pluginSetting: { nested: [1, 2.5, "x"] },
});
storage.addHistory({
  id: "full",
  title: "Weekly notes",
  createdAt: 1_700_000_000_123,
  durationMs: 4321.5,
  text: "\tOriginal café 🎙️\r\n  exact spacing  ",
  sourceRevision: 2,
  rewriteSourceRevision: 2,
  personalizedText: "Personalized result\r\n",
  editedText: "User's correction\n",
  magicText: "Accepted rewrite\r\n",
  magicModel: "qwen35Medium",
  magicPreset: "polish",
  magicIncludedInferences: true,
  magicProcessingTimeMs: 812.25,
  model: "r2t2",
  speechExecution: {
    modelId: "r2t2",
    backendId: "vllm-cuda",
    precision: "bf16",
    checkpoint: { repository: "netease-youdao/Confucius4-R2T2", revision: null },
    platform: "linux",
    device: "cuda",
  },
  language: "nl",
  requestedLanguage: "nl",
  recognizedLanguage: "nl",
  recognizedLanguages: ["nl"],
  languageStatus: "reported",
  dictationFormatting: "spoken",
  source: "file",
  sourceName: "meeting.m4a",
  processingTimeMs: 1500.75,
  delivery: { state: "paste-attempted", updatedAt: 1_700_000_001_000, method: "portal", detail: "Ctrl+V" },
  captureDiagnostics: {
    sampleCount: 48000,
    sampleRate: 48000,
    peakAmplitude: 0.5,
    rmsAmplitude: 0.125,
    clippedSampleCount: 0,
    clippingThreshold: 0.999,
  },
  timings: { captureEndMs: 12.5, inferenceMs: 900, rewritingMs: 300.33 },
  pluginMetadata: { tags: ["private"], score: 1e-7 },
} as never);
storage.addHistory({
  id: "minimal",
  createdAt: 1_700_000_100_000,
  durationMs: 0,
  text: "Short",
  model: "qwen3Asr",
  language: "en",
  source: "dictation",
  processingTimeMs: 0,
  title: null,
  sourceName: null,
});
copy(current, join(out, "current"));
rmSync(current, { recursive: true, force: true });

// An unversioned legacy profile and its Electron migration.
const legacy = mkdtempSync(join(tmpdir(), "delulu-fixture-"));
writeFileSync(
  join(legacy, "settings.json"),
  JSON.stringify({
    theme: "dark",
    shortcut: "CommandOrControl+Shift+Space",
    language: "NL",
    magicEnabled: true,
    preloadMagicModel: true,
    historyLimit: "100",
    liveTyping: true,
    speechDevice: "cpu",
    customWords: [{ term: "  Kubernetes ", replacement: "k8s", id: "k" }, { term: "Rust", language: 5 }],
    unknownLegacyFlag: "kept",
  }),
);
writeFileSync(
  join(legacy, "history.json"),
  JSON.stringify([
    {
      id: "old",
      createdAt: "1690000000000",
      durationMs: -5,
      intendedText: "Legacy intended text",
      editedIntendedText: "Legacy edit",
      technicalText: "drop me",
      dictationMode: "code",
      title: 42,
      delivery: { state: "copied", updatedAt: 5, method: "x".repeat(200) },
      recognizedLanguage: "EN",
      timings: { inferenceMs: 1.23456, bogus: 3 },
      extra: { kept: true },
    },
  ]),
);
copy(legacy, join(out, "legacy", "input"));
new StorageService(app(legacy) as never);
copy(legacy, join(out, "legacy", "migrated"));
rmSync(legacy, { recursive: true, force: true });
