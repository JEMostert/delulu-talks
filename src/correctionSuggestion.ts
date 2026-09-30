/** Propose only a bounded replacement from the text the user actually edited. */
export function correctionSuggestion(
  before: string,
  after: string,
): {
  heard: string;
  correct: string;
} | null {
  const original = [...before.matchAll(/\S+/gu)];
  const edited = [...after.matchAll(/\S+/gu)];
  let start = 0;
  let tail = 0;
  while (
    start < Math.min(original.length, edited.length) &&
    original[start][0] === edited[start][0]
  )
    start++;
  while (
    tail < Math.min(original.length, edited.length) - start &&
    original[original.length - 1 - tail][0] ===
      edited[edited.length - 1 - tail][0]
  )
    tail++;
  const from = original.slice(start, original.length - tail);
  const to = edited.slice(start, edited.length - tail);
  // Insertions, deletions, and broad rewrites do not identify a reusable recognition mistake.
  if (!from.length || !to.length || from.length > 8 || to.length > 8)
    return null;
  // Separate edits around an unchanged interior word are ambiguous; require manual review.
  if (from.some((word) => to.some((other) => word[0] === other[0])))
    return null;
  const heard = before.slice(
    from[0].index!,
    from[from.length - 1].index! + from[from.length - 1][0].length,
  );
  const correct = after.slice(
    to[0].index!,
    to[to.length - 1].index! + to[to.length - 1][0].length,
  );
  const letters = (value: string) => value.replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  if (
    heard.length > 256 ||
    correct.length > 256 ||
    !letters(heard) ||
    !letters(correct) ||
    letters(heard) === letters(correct)
  )
    return null;
  return { heard, correct };
}
