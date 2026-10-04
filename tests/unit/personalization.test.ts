import { describe, expect, test } from "bun:test";
import {
  personalize,
  personalizeWithUsage,
  previewPersonalization,
  splitForRewrite,
} from "../../src/personalization";
import type { CustomWord } from "../../src/types";

function rule(
  id: string,
  term: string,
  soundsLike: string,
  extra: Partial<CustomWord> = {},
): CustomWord {
  return { id, term, soundsLike, replacement: "", enabled: true, ...extra };
}

describe("personalization protects dictated content", () => {
  test("uses longest source matches once, respects language and word boundaries, and explains actual usage", () => {
    const words = [
      rule("phrase", "Delulu Talks", "dell ulu talks", { language: "en" }),
      rule("word", "Delulu", "dell ulu"),
      rule("no-cascade", "Wrong", "Delulu Talks"),
      rule("other-language", "Wrong", "send", { language: "nl" }),
      rule("disabled", "Wrong", "please", { enabled: false }),
    ];
    const source =
      "Please send DELL ULU TALKS and dell ulu; xdell ulu and dell ulu's stay.";
    const result =
      "Please send Delulu Talks and Delulu; xdell ulu and dell ulu's stay.";
    expect(personalize(source, words, "en-US")).toBe(result);
    expect(personalizeWithUsage(source, words, "English")).toEqual({
      text: result,
      counts: { phrase: 1, word: 1 },
    });
    expect(
      previewPersonalization(source, words, "en").matches.map(
        ({ index, matchedText }) =>
          source.slice(index, index + matchedText.length),
      ),
    ).toEqual(["DELL ULU TALKS", "dell ulu"]);
  });

  test("leaves addresses, paths, inline code and commands exact while correcting surrounding prose", () => {
    const words = [rule("name", "DELULU", "delulu")];
    const source =
      "delulu https://delulu.dev/a delulu /tmp/delulu/file\n`delulu` delulu\nbun run delulu\ndelulu";
    const expected =
      "DELULU https://delulu.dev/a DELULU /tmp/delulu/file\n`delulu` DELULU\nbun run delulu\nDELULU";
    expect(personalize(source, words)).toBe(expected);
    expect(personalizeWithUsage(source, words)).toEqual({
      text: expected,
      counts: { name: 4 },
    });
  });

  test("keeps exact multiline shortcut blocks outside rewriting, including blocks saved in another language", () => {
    const block = "Dear team,\r\n\tKeep THIS spacing.\r\nRegards, Boran";
    const words = [
      rule("signature", "sign off", "my signature", {
        kind: "shortcut",
        language: "en",
        replacement: block,
      }),
    ];
    const parts = splitForRewrite(
      `Polish this. my signature\nhttps://site.dev/my signature\n${block}`,
      words,
      "en",
    );
    expect(parts.map(({ text }) => text).join("")).toBe(
      `Polish this. ${block}\nhttps://site.dev/my signature\n${block}`,
    );
    expect(
      parts
        .filter(({ protected: protectedText }) => protectedText)
        .map(({ text }) => text),
    ).toEqual([block, "https://site.dev/my", block]);
    expect(splitForRewrite(`my signature\n${block}`, words, "nl")).toEqual([
      { text: "my signature\n", protected: false },
      { text: block, protected: true },
    ]);
  });
});
