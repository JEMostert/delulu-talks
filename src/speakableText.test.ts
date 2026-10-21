import { describe, expect, test } from "bun:test";
import { CODE_OMITTED, speakableText } from "./speakableText";

describe("speakableText", () => {
  test("a realistic agent reply becomes speakable words", () => {
    expect(
      speakableText(
        "Fixed `useWorkspace` in src/hooks/useWorkspace.ts — all 212 tests pass ✅",
      ),
    ).toBe(
      "Fixed use workspace in source slash hooks slash use workspace dot T S — all 212 tests pass",
    );
  });

  test("ordinary prose is unchanged", () => {
    const prose =
      "Done. The build is green, and I merged the fix. Want me to tag a release?";
    expect(speakableText(prose)).toBe(prose);
    expect(speakableText("Use it and/or skip it, yes/no.")).toBe(
      "Use it and/or skip it, yes/no.",
    );
  });

  test("voice tags pass through untouched", () => {
    const text =
      "[sigh] the build still fails. <whisper>Between us</whisper> [pause] it's [clear throat] fine [laugh].";
    expect(speakableText(text)).toBe(text);
    expect(speakableText("Escaped \\[laugh] stays")).toBe(
      "Escaped \\[laugh] stays",
    );
  });

  test("fenced code blocks are omitted once per run", () => {
    expect(
      speakableText(
        "Here is the fix:\n```ts\nconst a = 1;\n```\n\n```bash\nbun test\n```\nAll green.",
      ),
    ).toBe(`Here is the fix:\n${CODE_OMITTED}\nAll green.`);
    expect(speakableText("Start:\n~~~\nunclosed code\nmore")).toBe(
      `Start:\n${CODE_OMITTED}`,
    );
  });

  test("markdown structure keeps only the words", () => {
    expect(
      speakableText(
        "## Summary\n- **Fixed** the _cache_ path\n- [x] Added tests\n1. Merged\n> Quoted note\n---\n![diagram](a.png)",
      ),
    ).toBe(
      "Summary.\nFixed the cache path.\nAdded tests.\nMerged.\nQuoted note",
    );
  });

  test("links keep their label and bare URLs become host names", () => {
    expect(
      speakableText(
        "See [the release notes](https://github.com/x/y/releases) or https://www.github.com/JEMostert/delulu-talks/pull/12.",
      ),
    ).toBe("See the release notes or github dot com.");
    expect(speakableText("Docs: <https://docs.example.org/a>")).toBe(
      "Docs: docs dot example dot org",
    );
  });

  test("tables become comma lists", () => {
    expect(
      speakableText(
        "| Test | Result |\n| --- | :---: |\n| unit | pass |\n| e2e | fail |",
      ),
    ).toBe("Test, Result.\nunit, pass.\ne2e, fail.");
  });

  test("identifiers split into words", () => {
    expect(
      speakableText(
        "Renamed parseVoiceMarkup and MAX_RETRIES in VoiceService; set HF_TOKEN.",
      ),
    ).toBe(
      "Renamed parse voice markup and max retries in voice service; set HF token.",
    );
    expect(speakableText("Read `XMLHttpRequest` and `voice-bridge`.")).toBe(
      "Read XML http request and voice bridge.",
    );
  });

  test("file names spell short extensions and name known formats", () => {
    expect(
      speakableText(
        "Edited package.json, voiceMarkup.test.ts, README.md and ./scripts/build.sh",
      ),
    ).toBe(
      "Edited package dot JSON, voice markup dot test dot T S, readme dot M D and scripts slash build dot S H",
    );
    expect(speakableText("Check .env and ../config.yaml")).toBe(
      "Check dot env and up slash config dot YAML",
    );
  });

  test("versions, commits and operators are said aloud", () => {
    expect(speakableText("Released v0.16.0 from df63b50.")).toBe(
      "Released version 0 dot 16 dot 0 from d f 6 3 b 5 0.",
    );
    expect(speakableText("It takes 3.5 seconds and 2.0.1 total")).toBe(
      "It takes 3.5 seconds and 2 dot 0 dot 1 total",
    );
    expect(speakableText("`a !== b && c == d || e -> f`")).toBe(
      "a is not b and c equals d or e to f",
    );
  });

  test("emoji are dropped and whitespace is tidy", () => {
    expect(speakableText("  Shipped 🚀   it!  \n\n\n Next ✅ ")).toBe(
      "Shipped it!\nNext",
    );
  });
});

describe("speakableText edge cases", () => {
  test("abbreviations and ordinary punctuation stay", () => {
    const text = "E.g. this, i.e. that... Mr. Smith said 3/4 passed at 75%.";
    expect(speakableText(text)).toBe(text);
  });

  test("inline code drops brackets and separators", () => {
    expect(
      speakableText("Run `bun run test:unit` then `useState<number>(0)`."),
    ).toBe("Run bun run test unit then use state number 0.");
  });

  test("paths with a line number say the line", () => {
    expect(speakableText("See electron/services/main.ts:1169.")).toBe(
      "See electron slash services slash main dot T S line 1169.",
    );
  });

  test("generic types and comparisons in prose stay readable", () => {
    expect(speakableText("Returns Array<string> when x >= 3.")).toBe(
      "Returns Array<string> when x at least 3.",
    );
  });

  test("tags at the start of a list item survive", () => {
    expect(speakableText("- [laugh] that worked")).toBe("[laugh] that worked.");
  });
});
