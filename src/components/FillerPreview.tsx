import { useState } from "react";
import { fillerCandidates, previewFillerRemoval } from "../fillerPreview";
import { Modal } from "./ui";

export function FillerPreview({
  text,
  onClose,
  onDraft,
}: {
  text: string;
  onClose: () => void;
  onDraft: (source: string, result: string) => void;
}) {
  const [source, setSource] = useState(text);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(fillerCandidates),
  );
  const preview = previewFillerRemoval(source, [...selected]);
  const stale = source !== text;
  const oversized = source.length > 50_000;
  return (
    <Modal
      title="Remove filler words"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={
              stale ||
              oversized ||
              !preview.text.trim() ||
              preview.text === source
            }
            onClick={() => {
              if (!stale && !oversized) onDraft(source, preview.text);
            }}
          >
            Edit as correction
          </button>
        </>
      }
    >
      <p>Some of these words carry meaning; compare before you save.</p>
      {stale && (
        <div role="alert">
          <p className="field-error">The transcript changed.</p>
          <button className="secondary-button" onClick={() => setSource(text)}>
            Refresh
          </button>
        </div>
      )}
      {oversized && (
        <p className="field-error">
          Too long for this preview (50,000 characters at most).
        </p>
      )}
      <fieldset className="flex flex-wrap gap-3.5">
        <legend>Words</legend>
        {fillerCandidates.map((word) => (
          <label key={word} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.has(word)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(word);
                else next.delete(word);
                setSelected(next);
              }}
            />
            {word}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1">
        <label className="field">
          Source
          <textarea
            readOnly
            value={source}
            aria-label="Filler removal source"
            className="min-h-[200px]"
          />
        </label>
        <label className="field">
          Preview
          <textarea
            readOnly
            value={preview.text}
            aria-label="Filler removal preview"
            className="min-h-[200px]"
          />
        </label>
      </div>
      <p className="caption">
        {preview.counts.size
          ? [...preview.counts]
              .map(([word, count]) => `${word}: ${count}`)
              .join(" · ")
          : "None found."}
      </p>
    </Modal>
  );
}
