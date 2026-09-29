import { LANGUAGES } from "./data";
import type { CustomWord } from "./types";

export function normalizeRuleLanguage(language?: string): string {
  const value = (language ?? "").trim().toLowerCase();
  return LANGUAGES.find(([, name]) => name.toLowerCase() === value)?.[0]
    ?? value.split(/[-_]/)[0];
}
export const ruleLanguage = (rule: CustomWord): string =>
  normalizeRuleLanguage(rule.language);
export const ruleAppliesToLanguage = (rule: CustomWord, language?: string) =>
  !ruleLanguage(rule) || ruleLanguage(rule) === normalizeRuleLanguage(language);

export const ruleKind = (rule: CustomWord) =>
  rule.kind ?? (rule.replacement ? "shortcut" : "correction");
export const ruleTriggers = (rule: CustomWord): string[] => [
  ...new Set(
    [
      ...rule.soundsLike
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean),
      ...(ruleKind(rule) === "shortcut" ? [rule.term.trim()] : []),
    ].filter(Boolean),
  ),
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const wordCharacter = "[\\p{L}\\p{M}\\p{N}_]";
const phrasesPerCapture = 256;

function phrasePattern(groups: string[][]): RegExp {
  // Apostrophes inside a word are not quotation marks or phrase boundaries.
  return new RegExp(
    `(?<!${wordCharacter})(?<!${wordCharacter}['’])(?:${groups.map((phrases) => `(${phrases.map(escape).join("|")})`).join("|")})(?!${wordCharacter})(?!['’]${wordCharacter})`,
    "giu",
  );
}

function* phraseMatches(text: string, rules: Map<string, string>) {
  const phrases = [...rules.keys()].sort((a, b) => b.length - a.length);
  const groups: string[][] = [];
  for (let index = 0; index < phrases.length; index += phrasesPerCapture)
    groups.push(phrases.slice(index, index + phrasesPerCapture));
  // A capture per trigger exceeds V8's limit for valid large vocabularies.
  // Group sorted alternatives, then resolve within at most 256 phrases using
  // the same Unicode folding; cache repeated matches for long transcripts.
  const pattern = phrasePattern(groups);
  const outputs = new Map<string, string>();
  for (const match of text.matchAll(pattern)) {
    let output = outputs.get(match[0]);
    if (output === undefined) {
      const selected = match
        .slice(1)
        .findIndex((phrase) => phrase !== undefined);
      const phrase = groups[selected].find((phrase) =>
        samePhrase(phrase, match[0]),
      );
      if (phrase === undefined) continue;
      output = rules.get(phrase)!;
      outputs.set(match[0], output);
    }
    yield { index: match.index, length: match[0].length, output };
  }
}

const samePhrase = (phrase: string, other: string) =>
  new RegExp(`^(?:${escape(phrase)})$`, "iu").test(other);

function replacePhrases(text: string, rules: Map<string, string>): string {
  if (!rules.size) return text;
  let cursor = 0;
  let result = "";
  for (const match of phraseMatches(text, rules)) {
    result += text.slice(cursor, match.index) + match.output;
    cursor = match.index + match.length;
  }
  return result + text.slice(cursor);
}

export function ruleConflict(
  draft: CustomWord,
  words: CustomWord[],
): string | null {
  const triggers = ruleTriggers(draft);
  if (!triggers.length) return null;
  const pattern = new RegExp(`^(?:${triggers.map(escape).join("|")})$`, "iu");
  const conflict = words.find(
    (word) =>
      word.id !== draft.id &&
      (!ruleLanguage(word) || !ruleLanguage(draft) || ruleLanguage(word) === ruleLanguage(draft)) &&
      ruleTriggers(word).some((trigger) => pattern.test(trigger)),
  );
  return conflict
    ? `This phrase is already used by “${conflict.term}”. Edit that rule or choose another phrase.`
    : null;
}

export function personalize(text: string, words: CustomWord[], language?: string): string {
  const rules = new Map<string, string>();
  for (const word of words) {
    if (!word.enabled || !ruleAppliesToLanguage(word, language)) continue;
    const output = ruleKind(word) === "shortcut" ? word.replacement : word.term;
    if (!output.trim()) continue;
    for (const trigger of ruleTriggers(word)) {
      // Stable first-rule priority for legacy conflicts. Never cascade replacements.
      if (!rules.has(trigger)) rules.set(trigger, output);
    }
  }
  return replacePhrases(text, rules);
}

/** Keep saved blocks outside the language model. Rewrite only the surrounding text. */
export function splitForRewrite(
  text: string,
  words: CustomWord[],
  language?: string,
): Array<{ text: string; protected: boolean }> {
  const rules = new Map<string, string>();
  for (const word of words) {
    if (
      !word.enabled ||
      ruleKind(word) !== "shortcut" ||
      !word.replacement.trim()
    )
      continue;
    // Already saved exact blocks stay protected even when rewriting an older language.
    const triggers = ruleAppliesToLanguage(word, language) ? ruleTriggers(word) : [];
    for (const phrase of [word.replacement, ...triggers]) {
      if (!rules.has(phrase)) rules.set(phrase, word.replacement);
    }
  }
  if (!rules.size) return [{ text, protected: false }];
  const parts: Array<{ text: string; protected: boolean }> = [];
  let cursor = 0;
  for (const match of phraseMatches(text, rules)) {
    const index = match.index;
    if (index > cursor)
      parts.push({ text: text.slice(cursor, index), protected: false });
    parts.push({ text: match.output, protected: true });
    cursor = index + match.length;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), protected: false });
  return parts;
}
