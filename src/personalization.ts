import type { CustomWord } from "./types";

export const ruleKind = (rule: CustomWord) =>
  rule.kind ?? (rule.replacement ? "shortcut" : "correction");
export const ruleTriggers = (rule: CustomWord): string[] => [
  ...new Set([
    ...rule.soundsLike
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean),
    ...(ruleKind(rule) === "shortcut" ? [rule.term.trim()] : []),
  ]),
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function replacePhrases(text: string, rules: Map<string, string>): string {
  if (!rules.size) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${[...rules.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(
    pattern,
    (match) => rules.get(match.toLowerCase()) ?? match,
  );
}

export function ruleConflict(
  draft: CustomWord,
  words: CustomWord[],
): string | null {
  const triggers = new Set(
    ruleTriggers(draft).map((word) => word.toLowerCase()),
  );
  const conflict = words.find(
    (word) =>
      word.id !== draft.id &&
      ruleTriggers(word).some((trigger) => triggers.has(trigger.toLowerCase())),
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
      if (!rules.has(trigger.toLowerCase()))
        rules.set(trigger.toLowerCase(), output);
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
      if (!rules.has(phrase.toLowerCase()))
        rules.set(phrase.toLowerCase(), word.replacement);
    }
  }
  if (!rules.size) return [{ text, protected: false }];
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${[...rules.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  const parts: Array<{ text: string; protected: boolean }> = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const index = match.index!;
    if (index > cursor)
      parts.push({ text: text.slice(cursor, index), protected: false });
    parts.push({ text: rules.get(match[0].toLowerCase())!, protected: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), protected: false });
  return parts;
}
