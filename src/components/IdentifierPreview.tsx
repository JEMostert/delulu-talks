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
      title="Identifiers"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
          <button
            className="primary-button"
            disabled={!preview.trim() || !changed}
            onClick={() => onCopy(preview)}
          >
            <Copy /> Copy
          </button>
        </>
      }
    >
      <p>Say a style, the words, then “end identifier”.</p>
      <ul className="text-[12px] text-muted space-y-1">
        <li>camel case user account end identifier → userAccount</li>
        <li>pascal case user account end identifier → UserAccount</li>
        <li>snake case user account end identifier → user_account</li>
        <li>kebab case user account end identifier → user-account</li>
        <li>
          literal spelling capital A p i underscore two end identifier → Api_2
        </li>
      </ul>
      <label className="field">
        Recognized text
        <textarea
          autoFocus
          className="w-full min-h-[130px] whitespace-pre-wrap font-mono"
          maxLength={250_000}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </label>
      <p className="caption" role="status">
        {changed ? "Identifiers rendered." : "No complete identifier found."}
      </p>
      <label className="field">
        Preview
        <textarea
          readOnly
          className="w-full min-h-[130px] whitespace-pre-wrap font-mono"
          value={preview}
        />
      </label>
    </Modal>
  );
}
