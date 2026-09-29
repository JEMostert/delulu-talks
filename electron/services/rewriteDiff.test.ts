import { describe, expect, test } from "bun:test";
import { compareRewrite } from "../../src/rewriteDiff";

function verify(source: string, preview: string) {
  const diff = compareRewrite(source, preview);
  expect(
    diff.changes
      .filter((c) => c.kind !== "added")
      .map((c) => c.text)
      .join(""),
  ).toBe(source);
  expect(
    diff.changes
      .filter((c) => c.kind !== "removed")
      .map((c) => c.text)
      .join(""),
  ).toBe(preview);
  return diff;
}

describe("rewrite comparison", () => {
  test("identical and empty texts have no invented changes", () => {
    expect(verify("", "").changes).toEqual([]);
    expect(verify("don't\r\n Café 👩🏽‍💻", "don't\r\n Café 👩🏽‍💻").changes).toEqual([
      { kind: "unchanged", text: "don't\r\n Café 👩🏽‍💻" },
    ]);
    expect(verify("", "new").changes).toEqual([{ kind: "added", text: "new" }]);
    expect(verify("old", "").changes).toEqual([
      { kind: "removed", text: "old" },
    ]);
  });

  test("matches surrounding words and keeps replacements at word boundaries", () => {
    expect(
      verify("Ik bel morgen Amsterdam.", "Ik bel vandaag Rotterdam.").changes,
    ).toEqual([
      { kind: "unchanged", text: "Ik bel " },
      { kind: "removed", text: "morgen" },
      { kind: "added", text: "vandaag" },
      { kind: "unchanged", text: " " },
      { kind: "removed", text: "Amsterdam" },
      { kind: "added", text: "Rotterdam" },
      { kind: "unchanged", text: "." },
    ]);
  });

  test("keeps contractions whole and treats punctuation/formatting changes as changes", () => {
    expect(verify("I can't go!", "I can go.").changes).toContainEqual({
      kind: "removed",
      text: "can't",
    });
    const diff = verify("\tCafé\r\n  <script> & 'x'", " Café\n <script> & ‘x’");
    expect(
      diff.changes.some((c) => c.kind === "removed" && c.text.includes("\r\n")),
    ).toBe(true);
    verify("e\u0301én 😀 العربية 中文", "e\u0301én 👩🏽‍💻 עברית 中文");
  });

  test("repeated words and moved passages remain lossless", () => {
    verify("go go now go later", "go later go now go");
    verify(
      "Version v1.2.3: https://host/A?q=1",
      "Version v1.2.4: https://host/a?q=2",
    );
  });

  test("bounded fallback preserves long unrelated passages and common edges", () => {
    const source = "start " + "alpha ".repeat(8_000) + "end";
    const preview = "start " + "beta ".repeat(8_000) + "end";
    const diff = verify(source, preview);
    expect(diff.simplified).toBe(true);
    expect(diff.changes.at(0)).toEqual({ kind: "unchanged", text: "start " });
    expect(diff.changes.at(-1)?.kind).toBe("unchanged");
    expect(diff.changes.length).toBe(4);
    expect(verify(source, source.replace("start", "begin")).simplified).toBe(
      false,
    );
  });

  test("lossless comparison across randomized punctuation and Unicode inputs", () => {
    const tokens = [
      "word",
      "woord",
      "e\u0301",
      "👩🏽‍💻",
      "\r\n",
      " ",
      "\t",
      "&",
      "can't",
      "中文",
      "<",
      "العربية",
    ];
    let seed = 131;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < 150; n++) {
      const input = () =>
        Array.from(
          { length: next() % 30 },
          () => tokens[next() % tokens.length],
        ).join("");
      verify(input(), input());
    }
  });
});
