import { describe, expect, test } from "bun:test";
import {
  activityLabel,
  engineLabel,
  formatClock,
  relativeTime,
} from "./statusLabels";
import type { DictationStatus, MagicStatus } from "./types";

const speech = (patch: Partial<DictationStatus>): DictationStatus => ({
  phase: "idle",
  engine: "ready",
  message: "Ready",
  ...patch,
});
const rewrite = (patch: Partial<MagicStatus> = {}): MagicStatus => ({
  phase: "idle",
  engine: "unloaded",
  message: "Idle",
  ...patch,
});

describe("activityLabel", () => {
  test("is null while nothing is happening", () => {
    expect(activityLabel(speech({}), rewrite())).toBeNull();
  });
  test("speech activity wins over rewriting", () => {
    expect(
      activityLabel(
        speech({ phase: "listening", message: "Listening — hold" }),
        rewrite({ phase: "rewriting" }),
      ),
    ).toEqual({
      label: "Listening",
      tone: "recording",
      detail: "Listening — hold",
    });
  });
  test("reports rewriting when speech is idle", () => {
    expect(
      activityLabel(speech({}), rewrite({ phase: "loading" }))?.label,
    ).toBe("Loading rewriting");
  });
});

describe("engineLabel", () => {
  test("names the backend when ready", () => {
    expect(
      engineLabel(
        speech({
          capabilities: {
            schemaVersion: 1,
            engine: "speech",
            backend: "cuda-vllm",
            modelFamily: "r2t2",
            timestamps: false,
            languageHints: { supported: true, languages: [] },
            streaming: false,
            vocabularyBiasing: false,
          },
        }),
      ).label,
    ).toBe("Speech ready · CUDA");
  });
  test("asks for setup when the model is missing", () => {
    expect(engineLabel(speech({ engine: "missing" }))).toMatchObject({
      label: "Set up speech",
      tone: "warning",
    });
  });
});

describe("formatClock", () => {
  test("formats minutes and hours", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_400)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("relativeTime", () => {
  const now = new Date(2026, 9, 4, 15, 0).getTime();
  test("uses words for the last hour", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4 min ago");
  });
  test("uses a clock time later the same day", () => {
    expect(relativeTime(now - 3 * 3_600_000, now)).toMatch(/12/);
  });
});
