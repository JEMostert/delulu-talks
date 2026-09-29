import type { TranscriptRecord } from "./types";

type SearchSource = {
  id: "original" | "personalized" | "corrected" | "rewritten" | "filename";
  label: string;
  text: string;
};

export type HistorySearchResult = {
  source: SearchSource["id"];
  label: string;
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
  segments: { text: string; matched: boolean }[];
};

function sources(record: TranscriptRecord): SearchSource[] {
  const values: {
    id: SearchSource["id"];
    label: string;
    text: string | null | undefined;
  }[] = [
    { id: "original", label: "Original recognition", text: record.text },
    {
      id: "personalized",
      label: "Personalized text",
      text: record.personalizedText,
    },
    { id: "corrected", label: "Your correction", text: record.editedText },
    { id: "rewritten", label: "Accepted rewrite", text: record.magicText },
    { id: "filename", label: "Source filename", text: record.sourceName },
  ];
  return values.flatMap((value) =>
    typeof value.text === "string" && value.text.length
      ? [{ ...value, text: value.text }]
      : [],
  );
}

function literalMatcher(query: string): RegExp | null {
  const needle = query.trim();
  if (!needle) return null;
  // Treat punctuation and regex syntax as literal transcript content. Unicode
  // case folding preserves offsets in the original text for highlighting.
  return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

/** Compile once per filtering pass; the original stored fields remain untouched. */
export function createHistorySearch(query: string) {
  const matcher = literalMatcher(query);
  return (record: TranscriptRecord): boolean =>
    !matcher ||
    sources(record).some(({ text }) => {
      matcher.lastIndex = 0;
      return matcher.test(text);
    });
}

/** Return one bounded excerpt per matching layer, including hidden originals. */
export function historySearchResults(
  record: TranscriptRecord,
  query: string,
): HistorySearchResult[] {
  const matcher = literalMatcher(query);
  if (!matcher) return [];
  return sources(record).flatMap(({ id, label, text }) => {
    matcher.lastIndex = 0;
    const first = matcher.exec(text);
    if (!first) return [];
    let start = Math.max(0, first.index - 80);
    let end = Math.min(
      text.length,
      Math.max(first.index + first[0].length, first.index + 160),
    );
    // Excerpts must not split a UTF-16 surrogate pair at their boundaries.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
    const excerpt = text.slice(start, end);
    const segments: HistorySearchResult["segments"] = [];
    matcher.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(excerpt))) {
      if (match.index > cursor)
        segments.push({
          text: excerpt.slice(cursor, match.index),
          matched: false,
        });
      segments.push({ text: match[0], matched: true });
      cursor = match.index + match[0].length;
    }
    if (cursor < excerpt.length)
      segments.push({ text: excerpt.slice(cursor), matched: false });
    return [{
      source: id,
      label,
      leadingEllipsis: start > 0,
      trailingEllipsis: end < text.length,
      segments,
    }];
  });
}
