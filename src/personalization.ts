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

function* phraseMatches<T>(text: string, rules: Map<string, T>) {
  const phrases = [...rules.keys()].sort((a, b) => b.length - a.length);
  const groups: string[][] = [];
  for (let index = 0; index < phrases.length; index += phrasesPerCapture)
    groups.push(phrases.slice(index, index + phrasesPerCapture));
  // A capture per trigger exceeds V8's limit for valid large vocabularies.
  // Group sorted alternatives, then resolve within at most 256 phrases using
  // the same Unicode folding; cache repeated matches for long transcripts.
  const pattern = phrasePattern(groups);
  const outputs = new Map<string, { trigger: string; output: T }>();
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
      output = { trigger: phrase, output: rules.get(phrase)! };
      outputs.set(match[0], output);
    }
    yield {
      index: match.index,
      length: match[0].length,
      matchedText: match[0],
      ...output,
    };
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
  for (const word of words) {
    if (word.id === draft.id || (ruleLanguage(word) && ruleLanguage(draft) && ruleLanguage(word) !== ruleLanguage(draft))) continue;
    const existingTrigger = ruleTriggers(word).find((trigger) =>
      pattern.test(trigger),
    );
    if (existingTrigger === undefined) continue;
    // Keep both saved spellings: Unicode simple folding can match phrases
    // whose characters differ, such as “ſ” and “s”.
    const draftTrigger = triggers.find((trigger) =>
      samePhrase(trigger, existingTrigger),
    )!;
    const draftKind =
      ruleKind(draft) === "shortcut" ? "Text shortcut" : "Correction";
    const existingKind =
      ruleKind(word) === "shortcut" ? "text shortcut" : "correction";
    return `${draftKind} trigger “${draftTrigger}” is already used by ${existingKind} “${word.term}” (trigger “${existingTrigger}”${word.enabled ? "" : ", disabled"}). Edit that rule or choose another phrase.`;
  }
  return null;
}

function* enabledRules(words: CustomWord[], language?: string) {
  for (const word of words) {
    if (!word.enabled || !ruleAppliesToLanguage(word, language)) continue;
    const output = ruleKind(word) === "shortcut" ? word.replacement : word.term;
    if (!output.trim()) continue;
    for (const trigger of ruleTriggers(word)) {
      yield { trigger, output, rule: word };
    }
  }
}

export function personalize(text: string, words: CustomWord[], language?: string): string {
  const rules = new Map<string, string>();
  for (const { trigger, output } of enabledRules(words, language)) {
    // Stable first-rule priority for legacy conflicts. Never cascade replacements.
    if (!rules.has(trigger)) rules.set(trigger, output);
  }
  return replacePhrases(text, rules);
}

export type RuleMatch = {
  ruleId: string;
  term: string;
  kind: "correction" | "shortcut";
  trigger: string;
  matchedText: string;
  replacement: string;
  index: number;
};

/** Explain the same matching pass used for clean output; never save or cascade. */
export function previewPersonalization(text: string, words: CustomWord[], language?: string) {
  const rules = new Map<string, { output: string; rule: CustomWord }>();
  for (const { trigger, output, rule } of enabledRules(words, language)) {
    if (!rules.has(trigger)) rules.set(trigger, { output, rule });
  }
  const matches: RuleMatch[] = [];
  let result = "";
  let cursor = 0;
  if (rules.size) {
    for (const match of phraseMatches(text, rules)) {
      result += text.slice(cursor, match.index) + match.output.output;
      cursor = match.index + match.length;
      matches.push({
        ruleId: match.output.rule.id,
        term: match.output.rule.term,
        kind: ruleKind(match.output.rule),
        trigger: match.trigger,
        matchedText: match.matchedText,
        replacement: match.output.output,
        index: match.index,
      });
    }
  }
  return { original: text, result: result + text.slice(cursor), matches };
}

/** Keep saved blocks outside the language model. Rewrite only the surrounding text. */
export function splitForRewrite(
  text: string,
  words: CustomWord[],
  language?: string,
): Array<{ text: string; protected: boolean }> {
  const rules = new Map<string, string>();
  const savedBlocks = new Set<string>();
  for (const word of words) {
    if (
      !word.enabled ||
      ruleKind(word) !== "shortcut" ||
      !word.replacement.trim()
    )
      continue;
    savedBlocks.add(word.replacement);
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
    const matchedText = text.slice(index, index + match.length);
    // Triggers use case-insensitive recognition, but an already expanded block
    // must retain its bytes even when another block differs only in case.
    parts.push({
      text: savedBlocks.has(matchedText) ? matchedText : match.output,
      protected: true,
    });
    cursor = index + match.length;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), protected: false });
  return parts;
}
