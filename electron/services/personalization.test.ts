import { describe, expect, test } from "bun:test";
import {
  personalize,
  splitForRewrite,
  ruleConflict,
  ruleKind,
} from "../../src/personalization";
import type { CustomWord } from "../../src/types";
const correction: CustomWord = {
  id: "c",
  kind: "correction",
  term: "Delulu",
  soundsLike: "the lulu, de loo loo",
  replacement: "",
  enabled: true,
};
const shortcut: CustomWord = {
  id: "s",
  kind: "shortcut",
  term: "my signature",
  soundsLike: "sign off",
  replacement: "Boran\nDeveloper — $100 $(literal)",
  enabled: true,
};

describe("personalized output", () => {
  test("corrects whole phrases across punctuation and Unicode without cascading", () => {
    expect(personalize("THE LULU, de loo loo!", [correction])).toBe(
      "Delulu, Delulu!",
    );
    expect(personalize("éthe lulu and the lulué", [correction])).toBe(
      "éthe lulu and the lulué",
    );
    expect(
      personalize("the lulu", [
        correction,
        { ...correction, id: "b", term: "Changed", soundsLike: "Delulu" },
      ]),
    ).toBe("Delulu");
  });
  test("supports case-only corrections and literal symbols", () => {
    expect(
      personalize("Use github and c++.", [
        { ...correction, term: "GitHub", soundsLike: "github" },
        { ...correction, id: "b", term: "C++", soundsLike: "c++" },
      ]),
    ).toBe("Use GitHub and C++.");
  });
  test("preserves exact shortcut blocks and ignores disabled rules", () => {
    expect(personalize("Please use my signature", [shortcut])).toBe(
      `Please use ${shortcut.replacement}`,
    );
    expect(personalize("the lulu", [{ ...correction, enabled: false }])).toBe(
      "the lulu",
    );
  });
  test("migrates legacy kinds and detects cross-category trigger conflicts", () => {
    expect(ruleKind({ ...shortcut, kind: undefined })).toBe("shortcut");
    expect(
      ruleConflict({ ...correction, soundsLike: "MY SIGNATURE" }, [shortcut]),
    ).toContain("already used");
    expect(personalize("Delulu", [{ ...correction, soundsLike: "" }])).toBe(
      "Delulu",
    );
  });
  test("keeps repeated saved blocks out of model input without changing their bytes", () => {
    const text = `Hello ${shortcut.replacement}. Again: ${shortcut.replacement}`;
    const parts = splitForRewrite(text, [shortcut]);
    expect(
      parts
        .filter((part) => !part.protected)
        .map((part) => part.text)
        .join(""),
    ).toBe("Hello . Again: ");
    expect(
      parts.filter((part) => part.protected).map((part) => part.text),
    ).toEqual([shortcut.replacement, shortcut.replacement]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
  });
  test("protects trigger expansions and handles adjacent blocks and Unicode boundaries", () => {
    expect(
      splitForRewrite("my signature sign off", [shortcut])
        .map((part) => part.text)
        .join(""),
    ).toBe(`${shortcut.replacement} ${shortcut.replacement}`);
    expect(splitForRewrite("émy signature", [shortcut])).toEqual([
      { text: "émy signature", protected: false },
    ]);
    expect(splitForRewrite("Plain prose.", [shortcut])).toEqual([
      { text: "Plain prose.", protected: false },
    ]);
  });
});
