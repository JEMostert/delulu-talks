import { AUTO_LANGUAGE } from "./data";
import { ruleAppliesToLanguage, ruleKind } from "./personalization";
import type { CustomWord } from "./types";

/** Matches the worker's MAX_HOTWORDS_CHARS. */
export const MAX_RECOGNITION_HINT_CHARS = 1000;

/**
 * Correct spellings from enabled vocabulary corrections, as the comma-separated
 * hotword prompt R2T2 biases recognition toward. Text shortcuts expand typed
 * phrases rather than name spoken words, so they are not hints. With automatic
 * language detection, rules for every language apply.
 */
export function recognitionHints(
  words: readonly CustomWord[],
  language: string,
): string {
  const terms: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const word of words) {
    if (!word.enabled || ruleKind(word) !== "correction") continue;
    if (language !== AUTO_LANGUAGE && !ruleAppliesToLanguage(word, language))
      continue;
    const term = word.term.trim().replace(/\s+/gu, " ");
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    const added = term.length + (terms.length ? 2 : 0);
    if (length + added > MAX_RECOGNITION_HINT_CHARS) break;
    seen.add(key);
    terms.push(term);
    length += added;
  }
  return terms.join(", ");
}
