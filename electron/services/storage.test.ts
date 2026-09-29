import { beforeAll, describe, expect, mock, test } from "bun:test";
import { speechModelForPlatform } from "../runtime/platform";
import type { TranscriptRecord } from "../../src/types";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDirectory = "";
mock.module("electron", () => ({
  app: { getPath: () => testDirectory, isPackaged: false },
}));

let normalizeSettings: (typeof import("./storage"))["normalizeSettings"];
let applyTranscriptEdit: (typeof import("./storage"))["applyTranscriptEdit"];
let StorageService: (typeof import("./storage"))["StorageService"];

beforeAll(async () => {
  ({ normalizeSettings, applyTranscriptEdit, StorageService } =
    await import("./storage"));
});

describe("local data recovery", () => {
  test("migrates old Qwen speech settings without relabeling historical output or removing rewriting", () => {
    testDirectory = mkdtempSync(join(tmpdir(), "delulu-migration-"));
    try {
      writeFileSync(
        join(testDirectory, "settings.json"),
        JSON.stringify({
          workflowVersion: 1,
          model: "qwen3Asr",
          language: "nl",
          magicEnabled: true,
          magicModel: "qwen35Medium",
        }),
      );
      writeFileSync(
        join(testDirectory, "history.json"),
        JSON.stringify([
          {
            id: "old-qwen",
            text: "Mijn oorspronkelijke tekst.",
            model: "qwen3Asr",
            language: "nl",
            editedText: "Mijn correctie.",
          },
        ]),
      );
      const storage = new StorageService();
      expect(storage.getSettings().model).toBe(speechModelForPlatform());
      expect(storage.getSettings().magicEnabled).toBe(true);
      expect(storage.getSettings().magicModel).toBe("qwen35Medium");
      expect(storage.getHistory()[0].model).toBe("qwen3Asr");
      expect(storage.getHistory()[0].editedText).toBe("Mijn correctie.");
      expect(storage.getHistory()[0].text).toBe("Mijn oorspronkelijke tekst.");
    } finally {
      rmSync(testDirectory, { recursive: true, force: true });
    }
  });
  for (const filename of ["settings.json", "history.json"]) {
    test(`preserves corrupt ${filename} and other local data`, () => {
      testDirectory = mkdtempSync(join(tmpdir(), "delulu-storage-"));
      try {
        const settings = '{"language":"nl","workflowVersion":1}';
        const corrupt = '{"interrupted":';
        writeFileSync(join(testDirectory, "settings.json"), settings);
        writeFileSync(join(testDirectory, filename), corrupt);
        expect(() => new StorageService()).toThrow(
          "The file has been preserved",
        );
        expect(readFileSync(join(testDirectory, filename), "utf8")).toBe(
          corrupt,
        );
        if (filename === "history.json")
          expect(
            readFileSync(join(testDirectory, "settings.json"), "utf8"),
          ).toBe(settings);
      } finally {
        rmSync(testDirectory, { recursive: true, force: true });
      }
    });
  }
});

describe("settings migration", () => {
  test("shows onboarding until a first-run choice is persisted", () => {
    expect(normalizeSettings({}).onboardingComplete).toBe(false);
    expect(
      normalizeSettings({ onboardingComplete: true }).onboardingComplete,
    ).toBe(true);
  });

  test("migrates removed models to the R2T2 default", () => {
    const settings = normalizeSettings({
      model: "mossTranscribeDiarize",
      language: "auto",
      autoPaste: false,
      transcriptionMode: "dual",
      wordTimestamps: true,
      modelLicenseAccepted: true,
    });
    expect(settings.model).toBe(speechModelForPlatform());
    expect(settings.language).toBe("en");
    expect(settings.autoPaste).toBeFalse();
    expect(settings.shortcutMode).toBe("hold");
    expect(normalizeSettings({ shortcutMode: "toggle" }).shortcutMode).toBe(
      "toggle",
    );
  });

  test("moves the previous default shortcut to Meta + Z without changing custom bindings", () => {
    expect(
      normalizeSettings({ shortcut: "CommandOrControl+Shift+Space" }).shortcut,
    ).toBe("Super+Z");
    expect(normalizeSettings({ shortcut: "Ctrl+Alt+M" }).shortcut).toBe(
      "Ctrl+Alt+M",
    );
  });

  test("sanitizes custom vocabulary at the IPC boundary", () => {
    const settings = normalizeSettings({
      customWords: [
        { id: "x", term: " Nyra ", soundsLike: "nira", enabled: true },
        { term: "" },
      ],
    });
    expect(settings.customWords).toEqual([
      {
        kind: "correction",
        id: "x",
        term: "Nyra",
        soundsLike: "nira",
        replacement: "",
        enabled: true,
      },
    ]);
  });

  test("normalizes Magic model residency settings", () => {
    const settings = normalizeSettings({
      magicModel: "invented-8b",
      magicPreset: "invented",
      magicEnabled: false,
      magicAllowInferences: true,
      preloadMagicModel: false,
      modelIdleMinutes: 999,
    });
    expect(settings.magicModel).toBe("qwen35Medium");
    expect(settings.magicEnabled).toBeFalse();
    expect(settings.magicPreset).toBe("polish");
    expect(settings.magicAllowInferences).toBeTrue();
    expect(settings.preloadMagicModel).toBeFalse();
    expect(settings.modelIdleMinutes).toBe(15);
    expect(normalizeSettings({ modelIdleMinutes: 30 }).modelIdleMinutes).toBe(
      30,
    );
  });
});

describe("non-destructive transcript correction", () => {
  const record: TranscriptRecord = {
    id: "one",
    createdAt: 1,
    durationMs: 2_000,
    text: "Original text.",
    model: "r2t2",
    language: "en",
    source: "dictation",
    processingTimeMs: 200,
  };

  test("stores a correction beside the untouched model output", () => {
    const updated = applyTranscriptEdit(record, "  Corrected text.  ");
    expect(updated.text).toBe("Original text.");
    expect(updated.editedText).toBe("Corrected text.");
  });

  test("restores the original and rejects an empty correction", () => {
    const updated = applyTranscriptEdit(
      { ...record, editedText: "Corrected." },
      null,
    );
    expect(updated.editedText).toBeNull();
    expect(() => applyTranscriptEdit(record, "   ")).toThrow("cannot be empty");
  });
});
