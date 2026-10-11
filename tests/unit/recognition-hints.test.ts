import { expect, test } from "bun:test";
import {
  MAX_RECOGNITION_HINT_CHARS,
  recognitionHints,
} from "../../src/recognitionHints";
import type { CustomWord } from "../../src/types";

const rule = (term: string, extra: Partial<CustomWord> = {}): CustomWord => ({
  id: term,
  term,
  soundsLike: "",
  replacement: "",
  enabled: true,
  ...extra,
});

test("hints list enabled correction spellings once, without shortcuts", () => {
  const words = [
    rule("Kestrel"),
    rule("  Delulu   Talks "),
    rule("kestrel"),
    rule("Disabled", { enabled: false }),
    rule("my email", { kind: "shortcut", replacement: "me@example.com" }),
    rule("sig", { replacement: "Kind regards" }),
  ];
  expect(recognitionHints(words, "nl")).toBe("Kestrel, Delulu Talks");
});

test("language-scoped rules apply to their language, and to all with automatic detection", () => {
  const words = [
    rule("Utrecht", { language: "nl" }),
    rule("Seattle", { language: "en" }),
    rule("GitHub"),
  ];
  expect(recognitionHints(words, "nl")).toBe("Utrecht, GitHub");
  expect(recognitionHints(words, "en")).toBe("Seattle, GitHub");
  expect(recognitionHints(words, "auto")).toBe("Utrecht, Seattle, GitHub");
});

test("hints stay within the worker's character limit", () => {
  const words = Array.from({ length: 200 }, (_, index) =>
    rule(`Term${index.toString().padStart(3, "0")}`),
  );
  const hints = recognitionHints(words, "en");
  expect(hints.length).toBeLessThanOrEqual(MAX_RECOGNITION_HINT_CHARS);
  expect(hints.startsWith("Term000, Term001")).toBe(true);
  expect(hints.endsWith(",")).toBe(false);
});
