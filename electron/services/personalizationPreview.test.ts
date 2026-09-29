import { expect, test } from "bun:test";
import { personalize, previewPersonalization } from "../../src/personalization";
import type { CustomWord } from "../../src/types";

const correction: CustomWord = {
  id: "correction",
  kind: "correction",
  term: "Delulu",
  soundsLike: "the lulu, de loo loo",
  replacement: "",
  enabled: true,
};
const shortcut: CustomWord = {
  id: "shortcut",
  kind: "shortcut",
  term: "my signature",
  soundsLike: "sign off",
  replacement: "Fixture Person\nExact $100 $(literal)",
  enabled: true,
};

test("preview reports actual aliases and winning rules while preserving originals and exact blocks", () => {
  const words = [
    correction,
    shortcut,
    { ...correction, id: "disabled", soundsLike: "mistake", enabled: false },
    {
      ...correction,
      id: "cascade",
      soundsLike: "Delulu",
      term: "Wrong cascade",
    },
  ];
  const before = structuredClone(words);
  const source = "THE LULU: sign off; mistake.";
  const preview = previewPersonalization(source, words);
  expect(preview.original).toBe(source);
  expect(preview.result).toBe(
    "Delulu: Fixture Person\nExact $100 $(literal); mistake.",
  );
  expect(preview.result).toBe(personalize(source, words));
  expect(preview.matches).toEqual([
    {
      ruleId: "correction",
      term: "Delulu",
      kind: "correction",
      trigger: "the lulu",
      matchedText: "THE LULU",
      replacement: "Delulu",
      index: 0,
    },
    {
      ruleId: "shortcut",
      term: "my signature",
      kind: "shortcut",
      trigger: "sign off",
      matchedText: "sign off",
      replacement: shortcut.replacement,
      index: 10,
    },
  ]);
  expect(words).toEqual(before);
});

test("longest phrase and first legacy conflict win; preview omits losing and disabled rules", () => {
  const words = [
    { ...correction, id: "short", term: "Short", soundsLike: "the" },
    correction,
    { ...correction, id: "duplicate", term: "Duplicate" },
    { ...shortcut, enabled: false },
  ];
  const preview = previewPersonalization("the lulu and the; sign off", words);
  expect(preview.result).toBe("Delulu and Short; sign off");
  expect(preview.matches.map((match) => match.ruleId)).toEqual([
    "correction",
    "short",
  ]);
  expect(preview.result).toBe(personalize(preview.original, words));
});

test("Unicode folding across capture groups resolves the matching owner and literal boundaries", () => {
  const words = [
    { ...correction, id: "fold-first", term: "First", soundsLike: "K" },
    ...Array.from({ length: 300 }, (_, index) => ({
      ...correction,
      id: `padding-${index}`,
      soundsLike: `padding-${index}`,
    })),
    { ...correction, id: "fold-later", term: "Later", soundsLike: "k" },
  ];
  const preview = previewPersonalization("K and K; éK and Ké", words);
  expect(preview.result).toBe("First and First; éK and Ké");
  expect(
    preview.matches.map((match) => [
      match.ruleId,
      match.trigger,
      match.matchedText,
    ]),
  ).toEqual([
    ["fold-first", "K", "K"],
    ["fold-first", "K", "K"],
  ]);
  expect(preview.result).toBe(personalize(preview.original, words));
});

test("repeated occurrences remain in source order and empty/no-match inputs stay exact", () => {
  expect(
    previewPersonalization("the lulu, the lulu", [correction]).matches.map(
      (match) => match.index,
    ),
  ).toEqual([0, 10]);
  for (const source of ["", "  No match\n$() é  "]) {
    expect(previewPersonalization(source, [correction])).toEqual({
      original: source,
      result: source,
      matches: [],
    });
    expect(previewPersonalization(source, [])).toEqual({
      original: source,
      result: source,
      matches: [],
    });
  }
});
