import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const makeCorrection = (
  soundsLike: string,
  term = "Fixed",
  id = soundsLike,
): CustomWord => ({ ...correction, id, soundsLike, term });

const makeShortcut = (term: string, replacement = "EXACT\n$& $1") => ({
  ...shortcut,
  id: term,
  term,
  soundsLike: "",
  replacement,
});

describe("vocabulary edge cases", () => {
  test("does not cut accented graphemes or Unicode words", () => {
    const source =
      "cafe\u0301 éword e\u0301word word\u0301 中文word word中文 2word word2 _word word_ (word)";
    expect(
      personalize(source, [makeCorrection("cafe"), makeCorrection("word")]),
    ).toBe(
      "cafe\u0301 éword e\u0301word word\u0301 中文word word中文 2word word2 _word word_ (Fixed)",
    );
    expect(
      personalize("cafe\u0301, CAFÉ!", [
        makeCorrection("cafe\u0301, café", "Café"),
      ]),
    ).toBe("Café, Café!");
    expect(
      splitForRewrite("e\u0301word word\u0301 (word)", [makeShortcut("word")]),
    ).toEqual([
      { text: "e\u0301word word\u0301 (", protected: false },
      { text: "EXACT\n$& $1", protected: true },
      { text: ")", protected: false },
    ]);
  });

  test("matches literal dotted abbreviations without treating dots as wildcards", () => {
    const source = "dr. a.b. axb. xa.b. a.b.c [a.b.]";
    expect(
      personalize(source, [
        makeCorrection("dr.", "Dr."),
        makeCorrection("a.b.", "AB"),
      ]),
    ).toBe("Dr. AB axb. xa.b. a.b.c [AB]");
    expect(splitForRewrite("a.b. axb. a.b.c", [makeShortcut("a.b.")])).toEqual([
      { text: "EXACT\n$& $1", protected: true },
      { text: " axb. a.b.c", protected: false },
    ]);
  });

  test("keeps apostrophes inside words while allowing quoted phrases", () => {
    const source = "don't don’t 'don' ‘don’ don's don’s l'don l’don don";
    expect(personalize(source, [makeCorrection("don")])).toBe(
      "don't don’t 'Fixed' ‘Fixed’ don's don’s l'don l’don Fixed",
    );
    expect(
      personalize("don't don’t", [makeCorrection("don't, don’t", "do not")]),
    ).toBe("do not do not");
    expect(
      personalize("'s ochtends in 's-Gravenhage", [
        makeCorrection("'s-Gravenhage", "Den Haag"),
      ]),
    ).toBe("'s ochtends in Den Haag");
    expect(splitForRewrite("don't 'don'", [makeShortcut("don")])).toEqual([
      { text: "don't '", protected: false },
      { text: "EXACT\n$& $1", protected: true },
      { text: "'", protected: false },
    ]);
  });

  test("handles case-only corrections and Unicode simple case folding consistently", () => {
    const rules = [
      makeCorrection("github", "GitHub"),
      makeCorrection("s", "S"),
      makeCorrection("σ", "Σ"),
    ];
    expect(personalize("github GITHUB GitHub ſ ς σ", rules)).toBe(
      "GitHub GitHub GitHub S Σ Σ",
    );
    expect(
      splitForRewrite("ſ ς", [
        makeShortcut("s", "S block"),
        makeShortcut("σ", "Sigma block"),
      ]),
    ).toEqual([
      { text: "S block", protected: true },
      { text: " ", protected: false },
      { text: "Sigma block", protected: true },
    ]);
    expect(ruleConflict(makeCorrection("ſ"), [makeCorrection("s")])).toContain(
      "already used",
    );
    expect(ruleConflict(makeCorrection("ς"), [makeCorrection("σ")])).toContain(
      "already used",
    );
    expect(
      ruleConflict(makeCorrection("ss"), [makeCorrection("ß")]),
    ).toBeNull();
    expect(personalize("İ", [makeCorrection("İ", "Dotted I")])).toBe(
      "Dotted I",
    );
    expect(splitForRewrite("İ", [makeShortcut("İ")])).toEqual([
      { text: "EXACT\n$& $1", protected: true },
    ]);
    expect(
      ruleConflict(makeCorrection("İ"), [makeCorrection("i\u0307")]),
    ).toBeNull();
  });

  test("chooses the longest phrase at each position independent of rule order", () => {
    const short = makeCorrection("new", "OLD");
    const long = makeCorrection("new york", "NYC");
    const source = "new york; new; new yorker";
    for (const rules of [
      [short, long],
      [long, short],
    ]) {
      expect(personalize(source, rules)).toBe("NYC; OLD; OLD yorker");
    }
    expect(
      personalize("one two three", [
        makeCorrection("one two", "A"),
        makeCorrection("two three", "B"),
      ]),
    ).toBe("A three");
    expect(personalize("new york", [short, { ...long, enabled: false }])).toBe(
      "OLD york",
    );
    for (const rules of [
      [makeShortcut("new", "SHORT"), makeShortcut("new york", "LONG")],
      [makeShortcut("new york", "LONG"), makeShortcut("new", "SHORT")],
    ]) {
      expect(splitForRewrite("new york new", rules)).toEqual([
        { text: "LONG", protected: true },
        { text: " ", protected: false },
        { text: "SHORT", protected: true },
      ]);
    }
  });

  test("preserves first-rule priority for duplicate triggers without cascading", () => {
    const rules = [
      makeCorrection("foo", "bar", "first"),
      makeCorrection("FOO", "other", "second"),
      makeCorrection("bar", "final"),
    ];
    expect(personalize("foo bar", rules)).toBe("bar final");
    expect(personalize("foo", rules.slice().reverse())).toBe("other");
    expect(
      splitForRewrite("foo", [
        makeShortcut("foo", "first"),
        makeShortcut("FOO", "second"),
      ]),
    ).toEqual([{ text: "first", protected: true }]);
    for (const source of ["s", "ſ"]) {
      expect(
        personalize(source, [
          makeCorrection("s", "FIRST"),
          makeCorrection("ſ", "SECOND"),
        ]),
      ).toBe("FIRST");
      expect(
        splitForRewrite(source, [
          makeShortcut("s", "FIRST"),
          makeShortcut("ſ", "SECOND"),
        ]),
      ).toEqual([{ text: "FIRST", protected: true }]);
    }
  });

  test("preserves folded-rule priority across matcher groups", () => {
    const padding = Array.from({ length: 255 }, (_, index) =>
      makeCorrection(`p${String(index).padStart(3, "0")}`, "PADDING"),
    );
    expect(
      personalize("ſign sign ſign", [
        ...padding,
        makeCorrection("sign", "FIRST"),
        makeCorrection("ſign", "SECOND"),
      ]),
    ).toBe("FIRST FIRST FIRST");
  });

  test("inserts replacement syntax literally and preserves source/rule values", () => {
    const source = "say dollar then dollar";
    const rules = [makeShortcut("dollar", "$& $1 $$ $(literal)\n\\path")];
    const before = structuredClone(rules);
    expect(personalize(source, rules)).toBe(
      "say $& $1 $$ $(literal)\n\\path then $& $1 $$ $(literal)\n\\path",
    );
    expect(source).toBe("say dollar then dollar");
    expect(rules).toEqual(before);
  });

  test("empty shortcut triggers never create zero-length matches", () => {
    const empty = makeShortcut("   ");
    expect(personalize("ordinary prose", [empty])).toBe("ordinary prose");
    expect(splitForRewrite("ordinary prose", [empty])).toEqual([
      { text: "ordinary prose", protected: false },
    ]);
  });

  test("V8 supports 500 stored rules with 100,000 aliases without exceeding its capture limit", () => {
    // Run the real source in Node/V8: Bun's regex engine has a different limit.
    const source = readFileSync(
      new URL("../../src/personalization.ts", import.meta.url),
      "utf8",
    );
    const code = new Bun.Transpiler({
      loader: "ts",
      target: "node",
    }).transformSync(source);
    const checks = String.raw`
      import assert from 'node:assert/strict';
      try {
      const words = Array.from({ length: 500 }, (_, rule) => ({
        id: String(rule), kind: 'correction', term: 'fixed',
        replacement: '', enabled: true,
        soundsLike: Array.from({ length: 200 }, (_, alias) =>
          (rule * 200 + alias).toString(36).padStart(4, '0')
        ).join(','),
      }));
      assert.ok(words.every(word => word.soundsLike.length <= 1024));
      const last = (500 * 200 - 1).toString(36).padStart(4, '0');
      const input = '0000 ' + last + ' 0000';
      assert.equal(personalize(input, words), 'fixed fixed fixed');
      const shortcuts = words.map((word, index) => ({
        ...word, kind: 'shortcut', term: 'block-' + index,
        replacement: 'EXACT-' + index,
      }));
      assert.deepEqual(splitForRewrite(input, shortcuts), [
        { text: 'EXACT-0', protected: true },
        { text: ' ', protected: false },
        { text: 'EXACT-499', protected: true },
        { text: ' ', protected: false },
        { text: 'EXACT-0', protected: true },
      ]);
      assert.equal(personalize('İ i i\u0307', [{ ...words[0], soundsLike: 'İ' }]), 'fixed i i\u0307');
      console.log('V8 vocabulary limits passed');
      } catch (error) {
        console.error(error.name + ': ' + error.message.slice(-500));
        process.exitCode = 1;
      }
    `;
    expect(
      execFileSync(
        "node",
        ["--input-type=module", "-e", `${code}\n${checks}`],
        {
          encoding: "utf8",
          timeout: 20000,
        },
      ).trim(),
    ).toBe("V8 vocabulary limits passed");
  }, 25000);
});
