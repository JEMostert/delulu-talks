import { useRef, useState } from "react";
import { normalizeTranscriptTitle } from "../transcriptTitle";
import { Modal } from "./ui";

export function TranscriptTitleDialog({
  title,
  onClose,
  onSave,
}: {
  title: string | null;
  onClose: () => void;
  onSave: (title: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  let normalized: string | null = null;
  let validationError: string | null = null;
  try {
    normalized = normalizeTranscriptTitle(draft);
  } catch (reason) {
    validationError = reason instanceof Error ? reason.message : String(reason);
  }
  const changed = normalized !== title;
  const canSave = !busy && !validationError && changed;
  const close = () => {
    if (!saving.current) onClose();
  };
  const save = async () => {
    if (!canSave || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (await onSave(normalized)) onClose();
      else
        setError("The transcript title could not be saved. Please try again.");
    } catch {
      setError("The transcript title could not be saved. Please try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title ? "Edit transcript title" : "Add transcript title"}
      busy={busy}
      onClose={close}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {busy
              ? "Saving…"
              : normalized === null && title
                ? "Remove title"
                : "Save title"}
          </button>
        </>
      }
    >
      <p>
        Give this transcript an optional title. Leave it blank to remove the
        title.
      </p>
      <label className="field">
        Transcript title
        <input
          aria-label="Transcript title"
          aria-invalid={Boolean(validationError)}
          autoFocus
          maxLength={256}
          disabled={busy}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
      </label>
      {(validationError || error) && (
        <p className="field-error" role="alert">
          {validationError || error}
        </p>
      )}
    </Modal>
  );
}
