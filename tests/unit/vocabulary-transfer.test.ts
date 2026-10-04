import { expect, test } from "bun:test";
import {
  parseVocabularyBundle,
  serializeVocabularyBundle,
} from "../../src/vocabularyTransfer";
import type { CustomWord } from "../../src/types";

const rules: CustomWord[] = [
  {
    schemaVersion: 1,
    id: "kubectl",
    kind: "correction",
    term: "kubectl",
    language: "en",
    soundsLike: "cube control",
    aliases: ["cube cuddle", "kube cuttle"],
    replacement: "",
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "sign",
    kind: "shortcut",
    term: "my signature",
    soundsLike: "",
    replacement: "Met vriendelijke groet",
    enabled: false,
  },
];

test("rules with aliases and a language scope round-trip", () => {
  const bundle = parseVocabularyBundle(serializeVocabularyBundle(rules));
  expect(bundle.rules).toEqual(rules);
});

test("invalid aliases and language codes are rejected", () => {
  const raw = (patch: Record<string, unknown>) =>
    JSON.stringify({ schemaVersion: 1, rules: [{ ...rules[0], ...patch }] });
  expect(() => parseVocabularyBundle(raw({ aliases: "x" }))).toThrow(/aliases/);
  expect(() => parseVocabularyBundle(raw({ language: "not a code" }))).toThrow(
    /language/,
  );
});
