import { useId, useState } from "react";
import {
  parseTechnicalAddress,
  technicalAddressGuide,
  type TechnicalAddressKind,
} from "../technicalAddresses";

/** An explicit preview: guesses never replace speech or reach the destination. */
export function TechnicalAddressPreview({
  speech,
  onCopy,
}: {
  speech: string;
  onCopy: (text: string) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<TechnicalAddressKind>("path");
  const [source, setSource] = useState(speech);
  const [edited, setEdited] = useState<string | null>(null);
  const parsed = parseTechnicalAddress(source, kind);
  const preview = edited ?? parsed.text;
  return (
    <details className="mt-3 rounded-md border border-line p-3 text-[12px]">
      <summary className="cursor-pointer font-medium">Technical address preview</summary>
      <p className="mt-2 text-muted">
        Choose the spoken segment and its format. Review ambiguous pieces before copying.
        This preview keeps the original transcript and never executes commands.
      </p>
      <label htmlFor={`${id}-kind`} className="mt-3 block">Format</label>
      <select
        id={`${id}-kind`}
        className="mt-1 w-full bg-input p-2"
        value={kind}
        onChange={(event) => {
          setKind(event.target.value as TechnicalAddressKind);
          setEdited(null);
        }}
      >
        <option value="path">File path</option>
        <option value="extension">File extension</option>
        <option value="url">URL</option>
        <option value="email">Email address</option>
        <option value="version">Version</option>
      </select>
      <p className="mt-2 text-muted">Example: {technicalAddressGuide[kind].spoken}</p>
      <label htmlFor={`${id}-source`} className="mt-3 block">Spoken segment</label>
      <textarea
        id={`${id}-source`}
        className="mt-1 min-h-20 w-full rounded-md bg-input p-2"
        value={source}
        maxLength={20_000}
        onChange={(event) => {
          setSource(event.target.value);
          setEdited(null);
        }}
      />
      <label htmlFor={`${id}-preview`} className="mt-3 block">Editable preview</label>
      <textarea
        id={`${id}-preview`}
        className="mt-1 min-h-16 w-full rounded-md bg-input p-2 font-mono"
        value={preview}
        maxLength={20_000}
        spellCheck={false}
        onChange={(event) => setEdited(event.target.value)}
      />
      {parsed.warnings.length > 0 && (
        <div className="mt-2 text-muted" role="status">
          <p>Review these interpretations of the spoken segment:</p>
          <ul className="list-disc pl-5">
            {parsed.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      )}
      {edited !== null && <p className="mt-2 text-muted">Preview edited manually; check its final spelling.</p>}
      <div className="mt-3 flex gap-2">
        <button className="tool-button" disabled={!preview.trim()} onClick={() => onCopy(preview)}>
          Copy reviewed preview
        </button>
        <button className="tool-button" disabled={edited === null} onClick={() => setEdited(null)}>
          Reset preview
        </button>
      </div>
    </details>
  );
}
