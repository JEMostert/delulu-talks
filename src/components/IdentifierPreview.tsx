import { useState } from "react";
import { Copy } from "lucide-react";
import { Modal } from "./ui";
import { renderIdentifierCommands } from "../technicalIdentifiers";

export function IdentifierPreview({
  source,
  onCopy,
  onClose,
}: {
  source: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(source);
  const preview = renderIdentifierCommands(input);
  const changed = preview !== input;
  return (
    <Modal
      title="Identifier preview"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>Close</button>
          <button className="primary-button" disabled={!preview.trim() || !changed} onClick={() => onCopy(preview)}>
            <Copy /> Copy preview
          </button>
        </>
      }
    >
      <p>
        Say a style, the identifier words, then “end identifier”. Only marked
        identifiers change. Review and copy the result when ready.
      </p>
      <ul className="text-[12px] text-muted space-y-1">
        <li>camel case user account end identifier → userAccount</li>
        <li>pascal case user account end identifier → UserAccount</li>
        <li>snake case user account end identifier → user_account</li>
        <li>kebab case user account end identifier → user-account</li>
        <li>literal spelling capital A p i underscore two end identifier → Api_2</li>
      </ul>
      <label className="field">
        Recognized text / identifier commands
        <textarea
          autoFocus
          className="w-full min-h-[130px] whitespace-pre-wrap font-mono"
          maxLength={250_000}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </label>
      <p className="caption" role="status">
        {changed
          ? "Identifier commands rendered. Original transcript stays preserved."
          : "No valid complete identifier command found. Text is unchanged."}
      </p>
      <label className="field">
        Exact preview
        <textarea
          readOnly
          className="w-full min-h-[130px] whitespace-pre-wrap font-mono"
          value={preview}
        />
      </label>
      <p className="caption">This preview stays local and copies only on request.</p>
    </Modal>
  );
}
