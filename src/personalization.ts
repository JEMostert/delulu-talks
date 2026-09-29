import type { CustomWord } from "./types";

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

function phrasePattern(phrases: string[]): RegExp {
  // Apostrophes inside a word are not quotation marks or phrase boundaries.
  return new RegExp(
    `(?<!${wordCharacter})(?<!${wordCharacter}['’])(?:${phrases.map((phrase) => `(${escape(phrase)})`).join("|")})(?!${wordCharacter})(?!['’]${wordCharacter})`,
    "giu",
  );
}

function* phraseMatches(text: string, rules: Map<string, string>) {
  const phrases = [...rules.keys()].sort((a, b) => b.length - a.length);
  const pattern = phrasePattern(phrases);
  // Captures identify the selected rule even when Unicode case folding differs
  // from toLowerCase (long s, final sigma, or capital dotted I, for example).
  for (const match of text.matchAll(pattern)) {
    const selected = match.slice(1).findIndex((phrase) => phrase !== undefined);
    const output = rules.get(phrases[selected])!;
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
  const conflict = words.find(
    (word) =>
      word.id !== draft.id &&
      ruleTriggers(word).some((trigger) =>
        triggers.some((phrase) => samePhrase(phrase, trigger)),
      ),
  );
  return conflict
    ? `This phrase is already used by “${conflict.term}”. Edit that rule or choose another phrase.`
    : null;
}

export function personalize(text: string, words: CustomWord[]): string {
  const rules = new Map<string, string>();
  for (const word of words) {
    if (!word.enabled) continue;
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
): Array<{ text: string; protected: boolean }> {
  const rules = new Map<string, string>();
  for (const word of words) {
    if (
      !word.enabled ||
      ruleKind(word) !== "shortcut" ||
      !word.replacement.trim()
    )
      continue;
    for (const phrase of [word.replacement, ...ruleTriggers(word)]) {
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
