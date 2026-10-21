import { describe, expect, test } from "bun:test";
import { VOICE_LIMITS } from "./voice";
import { planVoiceChunks } from "./voiceChunks";
import { parseVoiceMarkup } from "./voiceMarkup";

const plan = (
  markup: string,
  options?: Parameters<typeof planVoiceChunks>[1],
) => planVoiceChunks(parseVoiceMarkup(markup).segments, options);

describe("planVoiceChunks", () => {
  test("a short briefing is one chunk", () => {
    expect(plan("Done. All tests pass.")).toEqual([
      {
        styles: [],
        parts: [{ kind: "text", text: "Done. All tests pass." }],
        text: "Done. All tests pass.",
      },
    ]);
  });

  test("events and pauses keep their order inside a chunk", () => {
    expect(
      plan("Okay, that one was my fault [laugh]. Fixed it [pause] for real."),
    ).toEqual([
      {
        styles: [],
        parts: [
          { kind: "text", text: "Okay, that one was my fault" },
          { kind: "event", tag: "laugh" },
          { kind: "text", text: ". Fixed it" },
          { kind: "pause", ms: 400 },
          { kind: "text", text: "for real." },
        ],
        text: "Okay, that one was my fault. Fixed it for real.",
      },
    ]);
  });

  test("a style change starts a new chunk", () => {
    const chunks = plan(
      "Hi there. <whisper>Between us, it was big.</whisper> Bye.",
    );
    expect(chunks.map((chunk) => [chunk.styles, chunk.text])).toEqual([
      [[], "Hi there."],
      [["whisper"], "Between us, it was big."],
      [[], "Bye."],
    ]);
  });

  test("the first chunk is short so audio starts quickly", () => {
    const sentence = "This sentence has exactly forty-six characters.";
    const chunks = plan(Array(12).fill(sentence).join(" "), {
      firstChunkCharacters: 100,
      chunkCharacters: 200,
    });
    expect(chunks[0].text).toBe(`${sentence} ${sentence}`);
    expect(chunks[1].text.length).toBeLessThanOrEqual(200);
    expect(chunks[1].text.length).toBeGreaterThan(100);
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(
      Array(12).fill(sentence).join(" "),
    );
  });

  test("sentences split at punctuation followed by space, not inside numbers", () => {
    const chunks = plan("It took 3.5 seconds. Version 2.0 shipped!", {
      firstChunkCharacters: 10,
      chunkCharacters: 10,
    });
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "It took 3.5 seconds.",
      "Version 2.0 shipped!",
    ]);
  });

  test("line breaks are boundaries", () => {
    const chunks = plan("Summary.\nFixed the bug.\nAdded tests.", {
      firstChunkCharacters: 10,
      chunkCharacters: 10,
    });
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Summary.",
      "Fixed the bug.",
      "Added tests.",
    ]);
  });

  test("overlong sentences split at commas, then spaces, within the ceiling", () => {
    const clause = "one two three four five six seven eight nine ten";
    const long = Array(20).fill(clause).join(", ");
    const chunks = plan(long);
    for (const chunk of chunks)
      expect(chunk.text.length).toBeLessThanOrEqual(
        VOICE_LIMITS.chunkCharacters,
      );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].text.startsWith("one")).toBe(true);
    const words = "word ".repeat(400).trim();
    for (const chunk of plan(words))
      expect(chunk.text.length).toBeLessThanOrEqual(
        VOICE_LIMITS.chunkCharacters,
      );
    const unbroken = "x".repeat(1500);
    expect(plan(unbroken).map((chunk) => chunk.text.length)).toEqual([
      600, 600, 300,
    ]);
  });

  test("leading and trailing pauses are dropped; boundary pauses stay with the previous chunk", () => {
    const chunks = plan(
      "[pause] Hello. [long-pause] <whisper>quiet</whisper> [pause]",
    );
    expect(chunks).toEqual([
      {
        styles: [],
        parts: [
          { kind: "text", text: "Hello." },
          { kind: "pause", ms: 1200 },
        ],
        text: "Hello.",
      },
      {
        styles: ["whisper"],
        parts: [{ kind: "text", text: "quiet" }],
        text: "quiet",
      },
    ]);
  });

  test("an utterance of only a sound is still spoken", () => {
    expect(plan("[laugh]")).toEqual([
      { styles: [], parts: [{ kind: "event", tag: "laugh" }], text: "" },
    ]);
    expect(plan("[pause] [long-pause]")).toEqual([]);
    expect(plan("")).toEqual([]);
  });

  test("never exceeds the part limit", () => {
    const chunks = plan(Array(250).fill("a [laugh]").join(" "));
    for (const chunk of chunks)
      expect(chunk.parts.length).toBeLessThanOrEqual(VOICE_LIMITS.chunkParts);
    expect(
      chunks.flatMap((chunk) => chunk.parts).filter((p) => p.kind === "event"),
    ).toHaveLength(250);
  });
});
