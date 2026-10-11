import { expect, test } from "bun:test";
import {
  MAX_HINT_WORDS,
  MAX_RECOGNITION_HINT_CHARS,
  hintWords,
  recognitionHints,
} from "../../src/recognitionHints";
import { WORD_PACKS, activeRules } from "../../src/wordPacks";
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

test("hints send at most the word limit, within the worker's character limit", () => {
  const words = Array.from({ length: 200 }, (_, index) =>
    rule(`Term${index.toString().padStart(3, "0")}`),
  );
  const hints = recognitionHints(words, "en").split(", ");
  expect(hints).toHaveLength(MAX_HINT_WORDS);
  expect(hints[hints.length - 1]).toBe("Term149");
  const long = Array.from({ length: 150 }, (_, index) =>
    rule(`${"x".repeat(40)}${index}`),
  );
  const capped = recognitionHints(long, "en");
  expect(capped.length).toBeLessThanOrEqual(MAX_RECOGNITION_HINT_CHARS);
  expect(capped.endsWith(",")).toBe(false);
});

test("own words come before word pack words and win duplicates", () => {
  const rules = activeRules({
    customWords: [rule("Delulu"), rule("github")],
    wordPacks: ["programming"],
  });
  const words = hintWords(rules);
  expect(words.slice(0, 3)).toEqual(["Delulu", "github", "TypeScript"]);
  expect(words).not.toContain("GitHub");
});

test("both word packs together leave room for own words", () => {
  const all = hintWords(
    activeRules({ customWords: [], wordPacks: ["programming", "gaming"] }),
  );
  expect(all.length).toBeLessThanOrEqual(MAX_HINT_WORDS - 30);
  expect(new Set(WORD_PACKS.map((pack) => pack.id)).size).toBe(
    WORD_PACKS.length,
  );
});
