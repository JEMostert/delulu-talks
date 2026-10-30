import { expect, test } from "bun:test";
import {
  dayLabel,
  groupByDay,
  highlight,
  hotkeyKeys,
  isTransientNotice,
  noticeTone,
  resultWord,
  whenLabel,
  formatMs,
  formatDate,
  languageName,
  settingsPatch,
  insertMessage,
  meterLevel,
  splitTerms,
  isTermList,
  termCount,
  serialQueue,
  restorePaste,
} from "./helpers";
import type { HistoryEntry, Settings } from "./ipc";
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
    overlay: true,
    firstRunDone: true,
    cleanup: true,
    cleanupModelOk: true,
    smartContext: true,
    radio: false,
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

test("hotkey triggers become keycaps", () => {
  expect(hotkeyKeys("Super+Z")).toEqual(["Super", "Z"]);
  expect(hotkeyKeys("<Super>z")).toEqual(["Super", "Z"]);
  expect(hotkeyKeys("Press <Control><Alt>space")).toEqual([
    "Ctrl",
    "Alt",
    "Space",
  ]);
  expect(hotkeyKeys(null)).toEqual([]);
});
test("days and times read like a person would say them", () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime();
  expect(dayLabel(now - 3600000, now)).toBe("Today");
  expect(dayLabel(new Date(2026, 9, 26, 23, 59).getTime(), now)).toBe(
    "Yesterday",
  );
  expect(whenLabel(now - 20000, now)).toBe("Just now");
  expect(whenLabel(now - 5 * 60000, now)).toBe("5 min ago");
});
test("history groups by day in order", () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime();
  const entry = (id: string, createdAt: number): HistoryEntry => ({
    id,
    createdAt,
    text: id,
    language: "en",
    model: "m",
    audioMs: 0,
    sttMs: 0,
    totalMs: 0,
  });
  const groups = groupByDay(
    [
      entry("a", now - 1000),
      entry("b", now - 2000),
      entry("c", now - 86400000),
    ],
    now,
  );
  expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
    ["Today", 2],
    ["Yesterday", 1],
  ]);
});
test("search highlights every case-insensitive match", () => {
  expect(highlight("Koffie and koffie", "KOFFIE")).toEqual([
    { text: "Koffie", match: true },
    { text: " and ", match: false },
    { text: "koffie", match: true },
  ]);
  expect(highlight("plain", " ")).toEqual([{ text: "plain", match: false }]);
});
test("result words and notice tones", () => {
  expect(resultWord({ kind: "pasted" })).toBe("Inserted");
  expect(resultWord({ kind: "skipped" })).toBe("Nothing heard");
  expect(noticeTone("Could not copy: denied")).toBe("error");
  expect(noticeTone("Copied to clipboard")).toBe("info");
  expect(isTransientNotice("Copied to clipboard")).toBe(true);
  expect(isTransientNotice("Copied — press Ctrl+V")).toBe(false);
});

test("mic meter uses a dB scale so normal speech fills the middle", () => {
  expect(meterLevel(0)).toBe(0);
  expect(meterLevel(Number.NaN)).toBe(0);
  expect(meterLevel(0.001)).toBe(0);
  expect(meterLevel(0.6)).toBe(1);
  expect(meterLevel(0.03)).toBeGreaterThan(0.45);
  expect(meterLevel(0.03)).toBeLessThan(0.6);
});
test("splits pasted vocabulary lists like the backend", () => {
  expect(splitTerms(" T3  Code ,Tauri\r\n\n  ,\tClaude\u0000Code ")).toEqual([
    "T3 Code",
    "Tauri",
    "Claude Code",
  ]);
  expect(splitTerms(" , \n ")).toEqual([]);
  expect(isTermList("T3 Code")).toBe(false);
  expect(isTermList("T3 Code\n")).toBe(false);
  expect(isTermList("T3 Code, Tauri")).toBe(true);
  expect(isTermList("T3 Code\nTauri")).toBe(true);
  expect(termCount(1)).toBe("1 term");
  expect(termCount(0)).toBe("0 terms");
});
test("serial queue runs tasks in call order, past failures", async () => {
  const run = serialQueue();
  const log: string[] = [];
  const later =
    (name: string, ms: number, fail = false) =>
    () =>
      new Promise<string>((resolve, reject) =>
        setTimeout(() => {
          log.push(name);
          if (fail) reject(new Error(name));
          else resolve(name);
        }, ms),
      );
  // The slow first task still finishes before the fast second one starts.
  const results = await Promise.allSettled([
    run(later("slow", 30)),
    run(later("broken", 1, true)),
    run(later("fast", 1)),
  ]);
  expect(log).toEqual(["slow", "broken", "fast"]);
  expect(results.map((r) => r.status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
});
test("a failed paste goes back into the term field", () => {
  // Untouched field: at the caret, or over the selection.
  expect(restorePaste("", "", 0, 0, "T3 Code\nTauri")).toBe("T3 Code, Tauri");
  expect(restorePaste("Whisper", "Whisper", 7, 7, "a,b")).toBe("Whisper, a, b");
  expect(restorePaste("x OLD y", "x OLD y", 2, 5, "a\nb")).toBe("x a, b y");
  expect(restorePaste("Claude", "Claude", 0, 0, "a, b")).toBe("a, b, Claude");
  // Typed meanwhile: keep it and append the list.
  expect(restorePaste("Gem", "", 0, 0, "a\nb")).toBe("Gem, a, b");
  expect(restorePaste("Gem, ", "x", 1, 1, "a\nb")).toBe("Gem, a, b");
  expect(restorePaste("  ", "x", 1, 1, "a\nb")).toBe("a, b");
  expect(restorePaste("keep", "keep", 4, 4, " , \n")).toBe("keep");
});
test("Delulu FM clock, readiness and status text", async () => {
  const { clock, readinessSteps, makingText } = await import("./radio");
  expect(clock(0)).toBe("0:00");
  expect(clock(151.9)).toBe("2:31");
  expect(readinessSteps(null)).toEqual([]);
  const steps = readinessSteps({
    comfy: {
      cli: true,
      server: false,
      nodes: true,
      checkpoint: true,
      url: "u",
    },
    writer: true,
    voice: false,
    installCommand: "c",
  });
  // A server that is down cannot vouch for its nodes or models.
  expect(steps.filter((s) => !s.ok).map((s) => s.id)).toEqual([
    "server",
    "nodes",
    "checkpoint",
    "voice",
  ]);
  expect(steps.find((s) => s.id === "voice")?.optional).toBe(true);
  // With ComfyUI down, nodes and model are unknown, not problems to fix.
  expect(steps.filter((s) => s.unknown).map((s) => s.id)).toEqual([
    "nodes",
    "checkpoint",
  ]);
  expect(steps.find((s) => s.id === "checkpoint")?.help).toBe(
    "Checked once ComfyUI is running.",
  );
  const radio = {
    making: {
      kind: "song",
      step: "music",
      title: "Copper",
      request: null,
      since: 0,
    },
  } as unknown as import("./ipc").Radio;
  expect(makingText(radio, 12_400)).toBe(
    "Composing “Copper” in ComfyUI · 12 s",
  );
});
