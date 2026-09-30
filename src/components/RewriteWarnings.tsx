import { useId, useMemo } from "react";
import { rewriteWarnings, type SensitiveValue } from "../rewriteWarnings";

function Values({
  values,
  direction,
}: {
  values: SensitiveValue[];
  direction: "Removed" | "Added";
}) {
  if (!values.length) return null;
  return (
    <div className="min-w-0">
      <strong className="text-sm">{direction}</strong>
      <ul className="mt-1 list-inside list-disc text-sm">
        {values.map(({ text, count }) => (
          <li key={text} className="whitespace-pre-wrap break-words">
            {direction === "Removed" ? <del>{text}</del> : <ins>{text}</ins>}
            {count > 1 && <span> ({count} occurrences)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RewriteWarnings({
  source,
  preview,
}: {
  source: string;
  preview: string;
}) {
  const heading = useId();
  const warnings = useMemo(
    () => rewriteWarnings(source, preview),
    [source, preview],
  );
  return (
    <section
      aria-labelledby={heading}
      className="mb-4 rounded-panel border border-line p-3"
    >
      <h3 id={heading} className="font-semibold">
        Review sensitive changes
      </h3>
      <p className="my-2 text-sm text-muted">
        Check numbers, dates, names, negations and URLs before using this
        rewrite. These are pattern matches, not a factual accuracy check.
        Capitalized text may be a name; lowercase names and other changes can be
        missed.
      </p>
      {warnings.length ? (
        <div
          className="max-h-64 overflow-auto"
          tabIndex={0}
          aria-label="Sensitive rewrite changes"
        >
          {warnings.map((warning) => (
            <div key={warning.label} className="mb-3">
              <h4 className="mb-1 text-sm font-semibold">{warning.label}</h4>
              <div className="grid grid-cols-2 gap-3">
                <Values values={warning.removed} direction="Removed" />
                <Values values={warning.added} direction="Added" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm">
          No changes found by these patterns. Compare the full texts before
          applying.
        </p>
      )}
    </section>
  );
}
