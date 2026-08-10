import { beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ app: {} }));

let normalizeSettings: typeof import("./storage")["normalizeSettings"];

beforeAll(async () => {
  ({ normalizeSettings } = await import("./storage"));
});

describe("settings migration", () => {
  test("migrates removed Tauri models to the balanced Crisper default", () => {
    const settings = normalizeSettings({ model: "mossTranscribeDiarize", language: "auto", autoPaste: false });
    expect(settings.model).toBe("crisperMedium");
    expect(settings.transcriptionMode).toBe("dual");
    expect(settings.language).toBe("en");
    expect(settings.autoPaste).toBeFalse();
  });

  test("sanitizes custom vocabulary at the IPC boundary", () => {
    const settings = normalizeSettings({ customWords: [{ id: "x", term: " Nyra ", soundsLike: "nira", enabled: true }, { term: "" }] });
    expect(settings.customWords).toEqual([{ id: "x", term: "Nyra", soundsLike: "nira", replacement: "", enabled: true }]);
  });
});
