export const fillerCandidates = ["ehm", "uhm", "um", "uh", "erm"] as const;

/** Explicit preview only: never feeds recognition, history, clipboard, or automatic delivery. */
export function previewFillerRemoval(
  source: string,
  selected: readonly string[],
) {
  const candidates = fillerCandidates.filter((word) => selected.includes(word));
  const counts = new Map<string, number>();
  if (!candidates.length) return { text: source, counts };
  // Preserve quoted literals and word interiors. Remove only a matched hesitation
  // plus its optional comma/one following space; leave other formatting untouched.
  const boundary = "[\\p{L}\\p{M}\\p{N}_'’\"`]";
  const pattern = new RegExp(
    `(?<!${boundary})(${candidates.join("|")})(?!${boundary})(?:,[ \\t]?|[ \\t])?`,
    "giu",
  );
  const text = source.replace(pattern, (_match, word: string) => {
    const key = word.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return "";
  });
  return { text, counts };
}
