import type { ModelProvenance as Provenance } from "../../types";

/** Where the weights come from: source, pinned revisions, conversion and license. */
export function ModelProvenance({
  hfId,
  provenance,
}: {
  hfId: string;
  provenance: Provenance;
}) {
  return (
    <div className="mt-3 space-y-3 text-xs text-muted [overflow-wrap:anywhere]">
      <p>
        Source:{" "}
        <a
          href={`https://huggingface.co/${hfId}`}
          target="_blank"
          rel="noreferrer"
        >
          {hfId} ↗
        </a>
      </p>
      {provenance.variants.map((variant) => (
        <div key={variant.label}>
          <p className="font-medium text-ink">{variant.label}</p>
          <p>
            Revision:{" "}
            {variant.revision ? (
              <a
                href={`https://huggingface.co/${hfId}/tree/${variant.revision}`}
                target="_blank"
                rel="noreferrer"
              >
                {variant.revision} ↗
              </a>
            ) : (
              "Upstream default (not pinned)"
            )}
          </p>
          <p>{variant.conversion}</p>
          {variant.attributionUrl && (
            <a href={variant.attributionUrl} target="_blank" rel="noreferrer">
              Conversion source ↗
            </a>
          )}
        </div>
      ))}
      <p>
        License:{" "}
        <a href={provenance.licenseUrl} target="_blank" rel="noreferrer">
          {provenance.licenseName} ↗
        </a>
      </p>
    </div>
  );
}
