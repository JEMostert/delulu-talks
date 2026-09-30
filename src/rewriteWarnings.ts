export type SensitiveValue = { text: string; count: number };
export type RewriteWarning = {
  label: string;
  removed: SensitiveValue[];
  added: SensitiveValue[];
};

const patterns: { label: string; pattern: RegExp }[] = [
  {
    label: "URLs",
    pattern: /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu,
  },
  {
    label: "Numbers",
    pattern:
      /(?<![\p{L}\p{N}_])[+-]?\p{N}+(?:[.,:/-]\p{N}+)*(?:\s?%)?(?![\p{L}\p{N}_])/gu,
  },
  {
    label: "Dates and days",
    pattern:
      /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|(?:\d{1,2}\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|januari|februari|maart|mei|juni|juli|augustus|oktober|december)(?:\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|today|tomorrow|yesterday|vandaag|morgen|gisteren)\b/giu,
  },
  {
    label: "Negations",
    pattern:
      /(?<![\p{L}\p{N}_])(?:no|not|never|neither|nor|without|cannot|[\p{L}]+n['’]t|niet|geen|nooit|nergens|niemand|niets|zonder)(?![\p{L}\p{N}_])/giu,
  },
  {
    label: "Possible names (capitalized text)",
    pattern:
      /(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{M}]+(?:[ '-]\p{Lu}[\p{L}\p{M}]+)*/gu,
  },
];

function values(text: string, pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function difference(
  left: Map<string, number>,
  right: Map<string, number>,
): SensitiveValue[] {
  const result: SensitiveValue[] = [];
  for (const [text, count] of left) {
    const delta = count - (right.get(text) ?? 0);
    if (delta > 0) result.push({ text, count: delta });
  }
  return result;
}

// Pattern matching flags literal changes only. It cannot certify factual
// equivalence or recognize every name/date, and does not send text elsewhere.
export function rewriteWarnings(
  source: string,
  preview: string,
): RewriteWarning[] {
  return patterns.flatMap(({ label, pattern }) => {
    const before = values(source, pattern);
    const after = values(preview, pattern);
    const removed = difference(before, after);
    const added = difference(after, before);
    return removed.length || added.length ? [{ label, removed, added }] : [];
  });
}
