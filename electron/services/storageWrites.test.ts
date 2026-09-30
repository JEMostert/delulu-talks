import { expect, test } from "bun:test";

const storageUrl = new URL("./storage.ts", import.meta.url).href;

for (const operation of [
  "settings",
  "add",
  "correct",
  "replace",
  "delete",
  "clear",
]) {
  test(`failed ${operation} persistence retains disk and memory, then an intentional retry succeeds`, async () => {
    // Isolate Electron module mocks from other storage/service test files.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { mock } from "bun:test";
          import assert from "node:assert/strict";
          import { mkdtempSync, readFileSync, rmSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          const root = mkdtempSync(join(tmpdir(), "delulu-write-failure-"));
          const fs = {...await import("node:fs")};
          let deniedTarget = null;
          mock.module("electron", () => ({ app: { getPath: () => root, isPackaged: false } }));
          mock.module("node:fs", () => ({...fs, renameSync(source, target) {
            if (target === deniedTarget) throw new Error("Injected atomic replacement failure");
            return fs.renameSync(source, target);
          }}));
          try {
            const { StorageService } = await import(${JSON.stringify(storageUrl)});
            const storage = new StorageService();
            const original = {
              id: "retained", createdAt: 1234, durationMs: 5000,
              text: "Original recognized speech 👋", model: "r2t2", language: "nl",
              source: "dictation", sourceName: null, processingTimeMs: 100,
              personalizedText: null, editedText: null, magicText: null,
              magicModel: null, magicPreset: null, magicIncludedInferences: false,
              magicProcessingTimeMs: 0,
            };
            storage.addHistory(original);
            const beforeSettings = storage.getSettings();
            const beforeHistory = storage.getHistory();
            const settingsFile = join(root, "settings.json");
            const historyFile = join(root, "history.json");
            const settingsBytes = readFileSync(settingsFile, "utf8");
            const historyBytes = readFileSync(historyFile, "utf8");
            const operation = ${JSON.stringify(operation)};
            const target = operation === "settings" ? settingsFile : historyFile;
            // Fail the final replacement, independently of the randomized
            // staging filename, while retaining the existing profile bytes.
            deniedTarget = target;
            const mutate = () => {
              switch (operation) {
                case "settings": return storage.updateSettings({ ...beforeSettings, language: "de" });
                case "add": return storage.addHistory({ ...original, id: "added", text: "New speech" });
                case "correct": return storage.updateTranscript(original.id, "Correction");
                case "replace": return storage.replaceHistory({ ...original, magicText: "Accepted rewrite" });
                case "delete": return storage.deleteHistory(original.id);
                case "clear": return storage.clearHistory();
              }
            };
            assert.throws(mutate);
            assert.deepEqual(storage.getSettings(), beforeSettings);
            assert.deepEqual(storage.getHistory(), beforeHistory);
            assert.equal(readFileSync(settingsFile, "utf8"), settingsBytes);
            assert.equal(readFileSync(historyFile, "utf8"), historyBytes);
            assert.equal(fs.readdirSync(root).some(name => name.endsWith(".tmp")), false);
            deniedTarget = null;
            mutate();
            assert.notEqual(readFileSync(target, "utf8"), operation === "settings" ? settingsBytes : historyBytes);
            assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), storage.getSettings());
            assert.deepEqual(JSON.parse(readFileSync(historyFile, "utf8")), JSON.parse(JSON.stringify(storage.getHistory())));
            const reopened = new StorageService();
            assert.deepEqual(reopened.getSettings(), storage.getSettings());
            assert.deepEqual(JSON.parse(JSON.stringify(reopened.getHistory())), JSON.parse(JSON.stringify(storage.getHistory())));
            process.stdout.write("verified");
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, diagnostic).toBe(0);
    expect(output).toBe("verified");
  });
}
