import { describe, expect, test } from "bun:test";
import { ruleConflict } from "../../src/personalization";
import type { CustomWord } from "../../src/types";

const correction: CustomWord = {
  id: "correction",
  kind: "correction",
  term: "Corrected",
  soundsLike: "misheard, SIGN OFF",
  replacement: "",
  enabled: true,
};
const shortcut: CustomWord = {
  id: "shortcut",
  kind: "shortcut",
  term: "my signature",
  soundsLike: "regards, sign off",
  replacement: "Example Person\nTechnical notes — $&",
  enabled: true,
};

describe("actionable vocabulary collisions", () => {
  test("identifies the conflicting alternative instead of the first alias or rule name", () => {
    const rules = [structuredClone(shortcut)];
    const before = JSON.stringify({ correction, rules });
    expect(ruleConflict(correction, rules)).toBe(
      "Correction trigger “SIGN OFF” is already used by text shortcut “my signature” (trigger “sign off”). Edit that rule or choose another phrase.",
    );
    expect(JSON.stringify({ correction, rules })).toBe(before);
  });

  test("explains the opposite category direction and shortcut primary trigger", () => {
    expect(ruleConflict(shortcut, [correction])).toBe(
      "Text shortcut trigger “sign off” is already used by correction “Corrected” (trigger “SIGN OFF”). Edit that rule or choose another phrase.",
    );
    expect(
      ruleConflict({ ...correction, soundsLike: "MY SIGNATURE" }, [shortcut]),
    ).toContain("trigger “my signature”");
  });

  test("labels disabled reservations and infers legacy rule kinds", () => {
    expect(
      ruleConflict({ ...correction, kind: undefined }, [
        { ...shortcut, kind: undefined, enabled: false },
      ]),
    ).toBe(
      "Correction trigger “SIGN OFF” is already used by text shortcut “my signature” (trigger “sign off”, disabled). Edit that rule or choose another phrase.",
    );
  });

  test("keeps both spellings when Unicode simple folding finds a collision", () => {
    for (const [draftTrigger, existingTrigger] of [
      ["ſign off", "sign off"],
      ["ς", "σ"],
      ["K", "k"],
    ]) {
      expect(
        ruleConflict({ ...correction, soundsLike: draftTrigger }, [
          { ...shortcut, soundsLike: existingTrigger },
        ]),
      ).toBe(
        `Correction trigger “${draftTrigger}” is already used by text shortcut “my signature” (trigger “${existingTrigger}”). Edit that rule or choose another phrase.`,
      );
    }
  });

  test("matches literal complete triggers without normalization or substring collisions", () => {
    for (const phrase of ["c++", "a.b.", "$&", "[note]", "say (hello)"]) {
      expect(
        ruleConflict({ ...correction, soundsLike: `unique, ${phrase}` }, [
          { ...shortcut, soundsLike: phrase },
        ]),
      ).toContain(`trigger “${phrase}”`);
    }
    for (const [draftTrigger, existingTrigger] of [
      ["ss", "ß"],
      ["İ", "i\u0307"],
      ["é", "e\u0301"],
      ["sign", "sign off"],
      ["a.b.", "axb."],
      ["c++", "ccc"],
    ]) {
      expect(
        ruleConflict({ ...correction, soundsLike: draftTrigger }, [
          { ...shortcut, soundsLike: existingTrigger },
        ]),
      ).toBeNull();
    }
  });

  test("allows editing the same rule and ignores correction output as a trigger", () => {
    expect(ruleConflict(shortcut, [shortcut])).toBeNull();
    expect(
      ruleConflict({ ...shortcut, term: correction.term, soundsLike: "" }, [
        correction,
      ]),
    ).toBeNull();
    expect(
      ruleConflict({ ...correction, soundsLike: " , " }, [shortcut]),
    ).toBeNull();
  });

  test("reports the first saved conflicting rule consistently for legacy duplicate data", () => {
    const second = { ...shortcut, id: "second", term: "other signature" };
    expect(ruleConflict(correction, [shortcut, second])).toContain(
      "text shortcut “my signature”",
    );
    expect(ruleConflict(correction, [second, shortcut])).toContain(
      "text shortcut “other signature”",
    );
  });
});
