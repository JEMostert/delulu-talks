import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/data";
import type { TranscriptRecord } from "../../src/types";
import { speechModelForPlatform } from "../runtime/platform";
import { StorageService, writeProfileJson } from "./storage";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function profile() {
  const directory = mkdtempSync(join(tmpdir(), "delulu-unit-profile-"));
  directories.push(directory);
  return {
    directory,
    application: { isPackaged: false, getPath: () => directory },
  };
}
function transcript(): TranscriptRecord {
  return {
    id: "speech",
    createdAt: 1,
    text: "Original café 🎙️",
    durationMs: 1000,
    processingTimeMs: 10,
    model: "r2t2",
    language: "en",
    source: "dictation",
  };
}

test("corrupt or future profiles fail before replacing either local data file", () => {
  const failures: Array<[string, string]> = [
    ["settings.json", '{"interrupted":'],
    ["settings.json", '{"workflowVersion":2}'],
    ["settings.json", '{"schemaVersion":999}'],
    ["settings.json", "null"],
    ["history.json", '{"interrupted":'],
    ["history.json", "null"],
    ["history.json", JSON.stringify([{ ...transcript(), schemaVersion: 999 }])],
  ];
  for (const [filename, invalid] of failures) {
    const { directory, application } = profile();
    const settings = join(directory, "settings.json");
    const history = join(directory, "history.json");
    const savedSettings = '{"workflowVersion":1}';
    const savedHistory = JSON.stringify([transcript()]);
    writeFileSync(settings, savedSettings);
    writeFileSync(history, savedHistory);
    writeFileSync(join(directory, filename), invalid);
    expect(() => new StorageService(application)).toThrow();
    expect(readFileSync(settings, "utf8")).toBe(
      filename === "settings.json" ? invalid : savedSettings,
    );
    expect(readFileSync(history, "utf8")).toBe(
      filename === "history.json" ? invalid : savedHistory,
    );
  }
});

test("failed atomic publication preserves saved bytes and removes its temporary file", () => {
  const { directory } = profile();
  const path = join(directory, "history.json");
  const original = JSON.stringify([transcript()]);
  writeFileSync(path, original);
  expect(() =>
    writeProfileJson(path, [], () => {
      throw new Error("Disk unavailable");
    }),
  ).toThrow("Disk unavailable");
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(directory)).toEqual(["history.json"]);
});

test("failed settings and transcript writes leave memory consistent with disk and allow retry", () => {
  const { directory, application } = profile();
  let denied = "";
  const storage = new StorageService(application, (path, value) => {
    if (path.endsWith(denied) && denied) throw new Error("Disk full");
    writeProfileJson(path, value);
  });
  storage.addHistory(transcript());
  const settings = storage.getSettings();
  const history = storage.getHistory();
  denied = "settings.json";
  expect(() => storage.updateSettings({ ...settings, language: "nl" })).toThrow(
    "Disk full",
  );
  expect(storage.getSettings()).toEqual(settings);
  denied = "history.json";
  expect(() => storage.updateTranscript("speech", "Edited")).toThrow(
    "Disk full",
  );
  expect(storage.getHistory()).toEqual(history);
  denied = "";
  storage.updateSettings({ ...settings, language: "nl" });
  storage.updateTranscript("speech", "Edited");
  const reopened = new StorageService(application);
  expect(reopened.getSettings().language).toBe("nl");
  expect(reopened.findHistory("speech")).toMatchObject({
    text: transcript().text,
    editedText: "Edited",
  });
  expect(
    JSON.parse(readFileSync(join(directory, "history.json"), "utf8")),
  ).toEqual(JSON.parse(JSON.stringify(reopened.getHistory())));
});

test("caller mutations cannot silently change saved history", () => {
  const { application } = profile();
  const storage = new StorageService(application);
  const record = transcript();
  storage.addHistory(record);
  record.text = "Changed outside storage";
  storage.findHistory(record.id)!.text = "Changed through lookup";
  expect(storage.findHistory(record.id)!.text).toBe(transcript().text);
  const replacement = { ...transcript(), editedText: "Intentional edit" };
  storage.replaceHistory(replacement);
  replacement.editedText = "External change";
  expect(
    new StorageService(application).findHistory(record.id)!.editedText,
  ).toBe("Intentional edit");
  expect(storage.findHistory(record.id)!.editedText).toBe("Intentional edit");
});

test("private results never become saved history when persistence is re-enabled", () => {
  const { directory, application } = profile();
  const storage = new StorageService(application);
  storage.addHistory(transcript());
  const original = readFileSync(join(directory, "history.json"), "utf8");
  storage.updateSettings({ ...storage.getSettings(), keepHistory: false });
  storage.addHistory({ ...transcript(), id: "private" });
  storage.updateSettings({ ...storage.getSettings(), keepHistory: true });
  storage.addHistory({
    ...transcript(),
    id: "still-private",
    sessionOnly: true,
  });
  expect(readFileSync(join(directory, "history.json"), "utf8")).toBe(original);
  expect(
    new StorageService(application).getHistory().map(({ id }) => id),
  ).toEqual(["speech"]);
});

test("opening an unchanged profile avoids redundant durable writes", () => {
  const { application } = profile();
  new StorageService(application);
  let writes = 0;
  new StorageService(application, (path, value) => {
    writes++;
    writeProfileJson(path, value);
  });
  expect(writes).toBe(0);
});

test("reopening a v0.10.0 profile preserves explicit settings, exact rules and every transcript text version", () => {
  const { directory, application } = profile();
  // v0.10.0 uses the same settings/workflow/transcript schema versions.
  const savedSettings = {
    ...DEFAULT_SETTINGS,
    model: speechModelForPlatform(),
    language: "nl",
    shortcut: "CommandOrControl+Shift+D",
    keepHistory: false,
    magicEnabled: true,
    preloadMagicModel: true,
    pastePortalToken: "saved-desktop-permission",
    customWords: [
      {
        schemaVersion: 1,
        id: "signature",
        kind: "shortcut",
        term: "my signature",
        language: "nl",
        soundsLike: "mijn handtekening",
        aliases: ["onderteken"],
        replacement: "\tMet vriendelijke groet,\r\n  Boran  \r\n",
        enabled: true,
      },
    ],
  };
  const savedHistory = [
    {
      ...transcript(),
      schemaVersion: 1 as const,
      text: "\tOriginal café 🎙️\r\n  exact spacing  ",
      personalizedText: "Personalized result\r\n",
      editedText: "User's correction\n",
      magicText: "Accepted rewrite\r\n",
      sourceRevision: 2,
      rewriteSourceRevision: 2,
      title: "Saved title",
      magicModel: "qwen35Medium" as const,
      magicPreset: "polish" as const,
    },
  ];
  const settingsBytes = JSON.stringify(savedSettings);
  const historyBytes = JSON.stringify(savedHistory);
  writeFileSync(join(directory, "settings.json"), settingsBytes);
  writeFileSync(join(directory, "history.json"), historyBytes);
  const upgraded = new StorageService(application);
  const reopened = new StorageService(application);
  for (const storage of [upgraded, reopened]) {
    expect(JSON.parse(JSON.stringify(storage.getSettings()))).toEqual(
      savedSettings,
    );
    expect(storage.getHistory()).toEqual(savedHistory);
  }
  expect(readFileSync(join(directory, "settings.json"), "utf8")).toBe(
    settingsBytes,
  );
  expect(readFileSync(join(directory, "history.json"), "utf8")).toBe(
    historyBytes,
  );
});
