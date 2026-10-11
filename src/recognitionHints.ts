import { AUTO_LANGUAGE } from "./data";
import { ruleAppliesToLanguage, ruleKind } from "./personalization";
import type { CustomWord } from "./types";

/** At most this many words, own words and word packs together, are hints. */
export const MAX_HINT_WORDS = 150;
/** Matches the worker's MAX_HOTWORDS_CHARS. */
export const MAX_RECOGNITION_HINT_CHARS = 3000;

/**
 * Correct spellings from enabled vocabulary corrections, deduplicated in rule
 * order. Text shortcuts expand typed phrases rather than name spoken words, so
 * they are not hints. With automatic language detection, rules for every
 * language apply.
 */
export function hintWords(
  words: readonly CustomWord[],
  language = AUTO_LANGUAGE,
): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    if (!word.enabled || ruleKind(word) !== "correction") continue;
    if (language !== AUTO_LANGUAGE && !ruleAppliesToLanguage(word, language))
      continue;
    const term = word.term.trim().replace(/\s+/gu, " ");
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/** The comma-separated hotword prompt R2T2 biases recognition toward. */
export function recognitionHints(
  words: readonly CustomWord[],
  language: string,
): string {
  let hints = "";
  for (const term of hintWords(words, language).slice(0, MAX_HINT_WORDS)) {
    const next = hints ? `${hints}, ${term}` : term;
    if (next.length > MAX_RECOGNITION_HINT_CHARS) break;
    hints = next;
  }
  return hints;
}
