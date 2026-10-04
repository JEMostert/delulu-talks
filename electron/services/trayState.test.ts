import { expect, test } from "bun:test";
import { menuPreview, trayState } from "./trayState";
import type { DictationStatus, MagicStatus } from "../../src/types";

const speech = (patch: Partial<DictationStatus> = {}): DictationStatus => ({
  phase: "idle",
  engine: "ready",
  message: "Ready",
  ...patch,
});
const rewrite: MagicStatus = { phase: "idle", engine: "unloaded", message: "" };
const shortcut = {
  accelerator: "Super+Z",
  registered: true,
  method: "native" as const,
  message: "",
};

test("recording outranks every other tray state", () => {
  expect(
    trayState({
      speech: speech({ phase: "listening", engine: "error" }),
      rewrite,
      update: { phase: "downloaded", currentVersion: "1", message: "" },
    }).icon,
  ).toBe("recording");
});

test("idle shows the shortcut, attention explains what is wrong", () => {
  expect(trayState({ speech: speech(), rewrite, shortcut })).toEqual({
    icon: "idle",
    statusLine: "Ready · Super+Z",
    tooltip: "Delulu Talks — Ready · Super+Z",
  });
  expect(
    trayState({
      speech: speech(),
      rewrite,
      shortcut: { ...shortcut, registered: false },
    }).statusLine,
  ).toBe("Shortcut unavailable — open Settings");
  expect(
    trayState({ speech: speech({ engine: "missing" }), rewrite }).icon,
  ).toBe("attention");
});

test("a ready update shows its version", () => {
  expect(
    trayState({
      speech: speech(),
      rewrite,
      update: {
        phase: "downloaded",
        currentVersion: "0.11.0",
        version: "0.11.1",
        message: "",
      },
    }),
  ).toMatchObject({ icon: "update", statusLine: "Update 0.11.1 ready" });
});

test("menu previews are one escaped line", () => {
  expect(menuPreview("Tom &\n  Jerry")).toBe("Tom && Jerry");
  expect(menuPreview("a".repeat(60), 10)).toBe(`${"a".repeat(9)}…`);
});
