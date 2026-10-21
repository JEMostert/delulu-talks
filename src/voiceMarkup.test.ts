import { describe, expect, test } from "bun:test";
import { parseVoiceMarkup, stripVoiceMarkup } from "./voiceMarkup";

describe("parseVoiceMarkup", () => {
  test("plain text is one unstyled segment", () => {
    const parsed = parseVoiceMarkup("  Done.   All tests pass.  ");
    expect(parsed.segments).toEqual([
      { kind: "text", text: "Done. All tests pass.", styles: [] },
    ]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.plainText).toBe("Done. All tests pass.");
  });

  test("inline sounds become events in order", () => {
    const parsed = parseVoiceMarkup(
      "Okay, that one was my fault [laugh]. Fixed it.",
    );
    expect(parsed.segments).toEqual([
      { kind: "text", text: "Okay, that one was my fault ", styles: [] },
      { kind: "event", tag: "laugh", styles: [] },
      { kind: "text", text: ". Fixed it.", styles: [] },
    ]);
    expect(parsed.plainText).toBe("Okay, that one was my fault. Fixed it.");
  });

  test("accepts aliases, case and spacing variants", () => {
    const tags = parseVoiceMarkup(
      "[Laughs] [ SIGHS ] [clear throat] [clear_throat] [giggle] [Chuckles] [gasps] [coughs] [clear-throat]",
    ).segments.map((segment) =>
      segment.kind === "event" ? segment.tag : segment.kind,
    );
    expect(tags).toEqual([
      "laugh",
      "sigh",
      "clear-throat",
      "clear-throat",
      "chuckle",
      "chuckle",
      "gasp",
      "cough",
      "clear-throat",
    ]);
  });

  test("pauses carry their length and timed pauses are clamped", () => {
    const pauses = parseVoiceMarkup(
      "a [pause] b [long-pause] c [long pause] d [pause 800ms] e [pause 2s] f [pause 60 seconds] g",
    ).segments.flatMap((segment) =>
      segment.kind === "pause" ? [segment.ms] : [],
    );
    expect(pauses).toEqual([400, 1200, 1200, 800, 2000, 5000]);
  });

  test("wrapping styles apply to their span and nest", () => {
    const parsed = parseVoiceMarkup(
      "Hi. <whisper>Between us, <slow>this was big</slow>.</whisper> Bye.",
    );
    expect(parsed.segments).toEqual([
      { kind: "text", text: "Hi. ", styles: [] },
      { kind: "text", text: "Between us, ", styles: ["whisper"] },
      { kind: "text", text: "this was big", styles: ["whisper", "slow"] },
      { kind: "text", text: ".", styles: ["whisper"] },
      { kind: "text", text: " Bye.", styles: [] },
    ]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.plainText).toBe("Hi. Between us, this was big. Bye.");
  });

  test("style aliases and case are accepted", () => {
    const styles = parseVoiceMarkup(
      "<Whispering>a</Whispering><fear>b</fear>",
    ).segments.map((segment) => segment.styles);
    expect(styles.slice(0, 2)).toEqual([["whisper"], ["scared"]]);
  });

  test("events inside a style keep that style", () => {
    const parsed = parseVoiceMarkup("<happy>We shipped it [laugh]</happy>");
    expect(parsed.segments[1]).toEqual({
      kind: "event",
      tag: "laugh",
      styles: ["happy"],
    });
  });

  test("closing tags close the most recent matching style, leniently", () => {
    const parsed = parseVoiceMarkup(
      "<soft><loud>a</soft>b</loud>c</whisper> d",
    );
    expect(parsed.segments).toEqual([
      { kind: "text", text: "a", styles: ["soft", "loud"] },
      { kind: "text", text: "b", styles: ["loud"] },
      { kind: "text", text: "c d", styles: [] },
    ]);
    expect(parsed.warnings).toEqual([
      "Closing tag </whisper> had no opening tag",
    ]);
  });

  test("unclosed styles close at the end with a warning", () => {
    const parsed = parseVoiceMarkup("<whisper>secret");
    expect(parsed.segments).toEqual([
      { kind: "text", text: "secret", styles: ["whisper"] },
    ]);
    expect(parsed.warnings).toEqual([
      "Unclosed tag <whisper> closed at the end",
    ]);
  });

  test("duplicate styles are applied once", () => {
    const parsed = parseVoiceMarkup("<slow><slow>a</slow>b</slow>c");
    expect(parsed.segments.map((segment) => segment.styles)).toEqual([
      ["slow"],
      [],
    ]);
    expect(parsed.plainText).toBe("abc");
  });

  test("unknown tag-shaped tokens are skipped with a warning", () => {
    const parsed = parseVoiceMarkup(
      "Hello [dances wildly] there <shout>now</shout>.",
    );
    expect(parsed.plainText).toBe("Hello there now.");
    expect(parsed.warnings).toEqual([
      "Unknown tag [dances wildly] skipped",
      "Unknown tag <shout> skipped",
      "Unknown tag </shout> skipped",
    ]);
  });

  test("ordinary brackets and comparisons stay literal", () => {
    for (const text of [
      "See note [1] and [x].",
      "- [ ] write tests",
      "Status [WIP] and [TODO].",
      "If a < b > c then a <= b and b >= c.",
      "It returns Array<string> or Map<K, V>.",
      "Use <T> here.",
      "Read [the docs](https://example.com) first.",
      "Escaped \\[laugh] tag",
    ]) {
      const parsed = parseVoiceMarkup(text);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.segments.every((segment) => segment.kind === "text")).toBe(
        true,
      );
    }
    expect(stripVoiceMarkup("Escaped \\[laugh] and \\<whisper>")).toBe(
      "Escaped [laugh] and <whisper>",
    );
    expect(stripVoiceMarkup("It returns Array<string>.")).toBe(
      "It returns Array<string>.",
    );
  });

  test("keeps line breaks as boundaries and collapses other whitespace", () => {
    const parsed = parseVoiceMarkup("First line\n\n\n  second\tline   ");
    expect(parsed.segments).toEqual([
      { kind: "text", text: "First line\nsecond line", styles: [] },
    ]);
  });

  test("whitespace-only spans between tags produce no segments", () => {
    const parsed = parseVoiceMarkup("[laugh] [sigh] <soft> </soft>");
    expect(parsed.segments.map((segment) => segment.kind)).toEqual([
      "event",
      "event",
    ]);
    expect(parsed.plainText).toBe("");
  });

  test("limits the number of simultaneous styles", () => {
    const open = [
      "whisper",
      "happy",
      "angry",
      "surprised",
      "scared",
      "sarcastic",
      "dramatic",
      "narration",
      "crying",
    ]
      .map((style) => `<${style}>`)
      .join("");
    const parsed = parseVoiceMarkup(`${open}text`);
    expect(parsed.segments[0].styles).toHaveLength(8);
    expect(parsed.warnings[0]).toContain("Only 8 styles");
  });
});
