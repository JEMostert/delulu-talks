import { expect, test } from "bun:test";
import {
  formatMs,
  formatDate,
  languageName,
  settingsPatch,
  insertMessage,
} from "./helpers";
import type { Settings } from "./ipc";
test("formats timings and dates", () => {
  expect(formatMs(250)).toBe("250 ms");
  expect(formatMs(1250)).toBe("1.3 s");
  expect(formatDate(0)).toBe(
    new Date(0).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
});
test("maps language names and settings without changing other values", () => {
  expect(languageName("nl", [{ code: "nl", name: "dutch" }])).toBe("Dutch");
  expect(languageName("xx", [])).toBe("Xx");
  const settings: Settings = {
    version: 1,
    microphone: null,
    startAtLogin: false,
    model: "small",
    insert: "off",
    theme: "system",
    language: "auto",
  };
  expect(settingsPatch(settings, "theme", "dark")).toEqual({
    ...settings,
    theme: "dark",
  });
  expect(settings.theme).toBe("system");
});
test("delivery messages preserve recovery information", () => {
  expect(insertMessage({ kind: "copied", reason: null })).toBe(
    "Copied — press Ctrl+V",
  );
  expect(
    insertMessage({ kind: "failed", reason: "Clipboard unavailable" }),
  ).toContain("Clipboard unavailable");
});
