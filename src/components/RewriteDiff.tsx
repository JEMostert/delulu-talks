import { useId, useMemo } from "react";
import { compareRewrite } from "../rewriteDiff";

export function RewriteDiff({
  source,
  preview,
}: {
  source: string;
  preview: string;
}) {
  const heading = useId();
  const { changes, simplified } = useMemo(
    () => compareRewrite(source, preview),
    [source, preview],
  );
  const changed = changes.some((change) => change.kind !== "unchanged");
  return (
    <section aria-labelledby={heading} className="mb-4">
      <h3 id={heading} className="mb-2 font-semibold">
        Changes from current text
      </h3>
      <p className="mb-2 text-sm text-muted">
        Removed text is struck through; added text is underlined. Spaces and
        line breaks are included.
      </p>
      {!changed && <p role="status">No changes from current text.</p>}
      {simplified && (
        <p className="mb-2 text-sm text-muted">
          Large change: the changed passage is shown together rather than
          matching individual words. Both texts remain complete above.
        </p>
      )}
      {changed && (
        <div
          tabIndex={0}
          aria-label="Rewrite changes"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-panel border border-line p-3 text-sm"
        >
          {changes.map((change, index) =>
            change.kind === "unchanged" ? (
              <span key={index}>{change.text}</span>
            ) : change.kind === "removed" ? (
              <span key={index}>
                <span className="sr-only">Removed text: </span>
                <del className="decoration-2">{change.text}</del>
                <span className="sr-only"> End removed text. </span>
              </span>
            ) : (
              <span key={index}>
                <span className="sr-only">Added text: </span>
                <ins className="decoration-2 underline-offset-4">
                  {change.text}
                </ins>
                <span className="sr-only"> End added text. </span>
              </span>
            ),
          )}
        </div>
      )}
    </section>
  );
}
