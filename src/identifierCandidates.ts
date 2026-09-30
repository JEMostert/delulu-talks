export interface IdentifierCandidate {
  symbol: string;
  /** Deterministic 0–100 ranking score, not a recognition confidence. */
  score: number;
  reason: string;
}

const MAX_INPUT = 256;
const MAX_IDENTIFIER = 128;
const MAX_SYMBOLS = 3_000;
const allowedText = /^[\p{L}\p{N}_$\s-]+$/u;

function compactIdentifier(value: string): string {
  return value
    .normalize("NFC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .join("")
    .toLowerCase()
    .normalize("NFC");
}

/** Unicode code-point order avoids machine-locale dependent tie breaking. */
function compareSymbols(first: string, second: string): number {
  const a = Array.from(first, (character) => character.codePointAt(0)!);
  const b = Array.from(second, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** Banded Levenshtein; values above the threshold are deliberately discarded. */
function boundedDistance(
  first: string[],
  second: string[],
  threshold: number,
): number {
  if (Math.abs(first.length - second.length) > threshold) return threshold + 1;
  const outside = threshold + 1;
  let previous = new Array<number>(second.length + 1).fill(outside);
  for (let index = 0; index <= Math.min(second.length, threshold); index += 1)
    previous[index] = index;
  for (let row = 1; row <= first.length; row += 1) {
    const current = new Array<number>(second.length + 1).fill(outside);
    if (row <= threshold) current[0] = row;
    const start = Math.max(1, row - threshold);
    const end = Math.min(second.length, row + threshold);
    let minimum = current[0];
    for (let column = start; column <= end; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1),
      );
      minimum = Math.min(minimum, current[column]);
    }
    if (minimum > threshold) return outside;
    previous = current;
  }
  return previous[second.length];
}

/**
 * Rank only supplied project-scoped identifiers without changing speech or
 * symbols. Similarity uses written characters, never phonetic inference.
 * Suggestions with a normalized edit distance above 0.5 are omitted, including
 * prefix matches. At most the first 3,000 supplied symbols are considered.
 */
export function rankIdentifierCandidates(
  rawSpeech: string,
  symbols: readonly string[],
  limit = 8,
): IdentifierCandidate[] {
  if (
    typeof rawSpeech !== "string" ||
    !rawSpeech.trim() ||
    rawSpeech.length > MAX_INPUT ||
    !allowedText.test(rawSpeech) ||
    !Number.isFinite(limit)
  )
    return [];
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const normalizedSpeech = rawSpeech.trim().normalize("NFC");
  const speech = compactIdentifier(normalizedSpeech);
  const speechCharacters = Array.from(speech);
  if (!speechCharacters.length || speechCharacters.length > MAX_IDENTIFIER)
    return [];
  const candidates: IdentifierCandidate[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols.slice(0, MAX_SYMBOLS)) {
    if (
      typeof symbol !== "string" ||
      !symbol ||
      symbol.length > MAX_IDENTIFIER ||
      !allowedText.test(symbol) ||
      seen.has(symbol)
    )
      continue;
    seen.add(symbol);
    const normalizedSymbol = symbol.normalize("NFC");
    const compact = compactIdentifier(normalizedSymbol);
    const characters = Array.from(compact);
    if (!characters.length || characters.length > MAX_IDENTIFIER) continue;
    if (symbol === rawSpeech) {
      candidates.push({ symbol, score: 100, reason: "Exact identifier text." });
    } else if (normalizedSymbol === normalizedSpeech) {
      candidates.push({
        symbol,
        score: 99,
        reason: "Exact text after Unicode normalization and trimming.",
      });
    } else if (
      normalizedSymbol.toLowerCase() === normalizedSpeech.toLowerCase()
    ) {
      candidates.push({
        symbol,
        score: 98,
        reason: "Same identifier text with different casing.",
      });
    } else if (compact === speech) {
      candidates.push({
        symbol,
        score: 96,
        reason: "Same identifier words with different casing or separators.",
      });
    } else {
      const length = Math.max(speechCharacters.length, characters.length);
      const threshold = Math.floor(length * 0.5);
      const distance = boundedDistance(speechCharacters, characters, threshold);
      if (distance > threshold) continue;
      const similarity = 1 - distance / length;
      const prefix = compact.startsWith(speech) || speech.startsWith(compact);
      candidates.push({
        symbol,
        score: Math.round(60 + similarity * 30 + (prefix ? 2 : 0)),
        reason: prefix
          ? "Shared identifier prefix within the written-text similarity threshold."
          : "Similar written identifier characters within the edit-distance threshold.",
      });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || compareSymbols(a.symbol, b.symbol))
    .slice(0, boundedLimit);
}
