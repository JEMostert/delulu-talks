import { historySearchResults } from "../historySearch";
import type { TranscriptRecord } from "../types";

/** Search evidence is separate from the delivered text and its copy/edit actions. */
export function HistorySearchMatches({
  record,
  query,
}: {
  record: TranscriptRecord;
  query: string;
}) {
  const results = historySearchResults(record, query);
  if (!results.length) return null;
  return (
    <section
      aria-label="Matching transcript text"
      className="mt-2 rounded-md border border-line bg-soft p-3"
    >
      <h4 className="caption mb-2">Search matches by source</h4>
      <ul className="grid gap-3">
        {results.map((result) => (
          <li key={result.source} className="min-w-0">
            <p className="caption mb-1 font-semibold">{result.label}</p>
            <p className="text-[12px] leading-relaxed whitespace-pre-wrap wrap-anywhere">
              {result.leadingEllipsis && "…"}
              {result.segments.map((segment, index) =>
                segment.matched ? (
                  <mark
                    key={index}
                    className="rounded-sm bg-amber-200 px-0.5 text-slate-950"
                  >
                    <span className="sr-only">Match: </span>
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
              {result.trailingEllipsis && "…"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
