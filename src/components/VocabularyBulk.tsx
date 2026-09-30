import { useRef, useState } from "react";
import { personalize, ruleKind } from "../personalization";
import type { CustomWord } from "../types";
import { Modal } from "./ui";

type BulkAction = "enable" | "disable" | "remove";
type Undo = { before: CustomWord[]; after: CustomWord[] };

// Include every saved field and preserve rule order (legacy conflicts use first priority).
function fingerprint(words: CustomWord[]): string {
  return JSON.stringify(
    words.map((word) => ({
      id: word.id,
      kind: ruleKind(word),
      term: word.term,
      soundsLike: word.soundsLike,
      replacement: word.replacement,
      enabled: word.enabled,
    })),
  );
}

export function VocabularyBulk({
  words,
  saving,
  onChange,
}: {
  words: CustomWord[];
  saving: boolean;
  onChange: (words: CustomWord[]) => Promise<boolean>;
}) {
  const [baseline, setBaseline] = useState<CustomWord[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<BulkAction>("disable");
  const [phrase, setPhrase] = useState("");
  const [undo, setUndo] = useState<Undo | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const current = fingerprint(words);
  const stale = baseline !== null && fingerprint(baseline) !== current;
  const proposed =
    baseline?.flatMap((word) => {
      if (!selected.has(word.id)) return [word];
      return action === "remove"
        ? []
        : [{ ...word, enabled: action === "enable" }];
    }) ?? [];
  const changed =
    baseline !== null && fingerprint(proposed) !== fingerprint(baseline);
  const undoAvailable = undo !== null && fingerprint(undo.after) === current;
  const busy = saving || submitting;

  async function persist(next: CustomWord[], complete: () => void) {
    if (saving || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError("");
    try {
      if (await onChange(next)) complete();
      else
        setError(
          "Rules could not be saved. No bulk change was confirmed; try again.",
        );
    } catch {
      setError(
        "Rules could not be saved. No bulk change was confirmed; try again.",
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-wrap items-center gap-3.5">
      <button
        className="secondary-button"
        disabled={busy || !words.length}
        onClick={() => {
          setBaseline(words.map((word) => ({ ...word })));
          setSelected(new Set());
          setAction("disable");
          setPhrase("");
          setError("");
        }}
      >
        Bulk update rules
      </button>
      {undo && (
        <>
          <button
            className="secondary-button"
            disabled={busy || !undoAvailable}
            onClick={() => {
              if (!undoAvailable) return;
              void persist(undo.before, () => {
                setUndo(null);
              });
            }}
          >
            Undo last bulk update
          </button>
          {!undoAvailable && (
            <span className="caption">
              Rules changed since the bulk update. Undo is unavailable to
              preserve those edits.
            </span>
          )}
        </>
      )}
      {!baseline && error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {baseline && (
        <Modal
          title="Preview bulk rule update"
          busy={busy}
          onClose={() => setBaseline(null)}
          footer={
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setBaseline(null)}
              >
                Cancel
              </button>
              <button
                className={
                  action === "remove" ? "danger-button" : "primary-button"
                }
                disabled={busy || stale || !changed}
                onClick={() => {
                  if (stale || !changed) return;
                  const before = baseline;
                  const after = proposed;
                  void persist(after, () => {
                    setUndo({ before, after });
                    setBaseline(null);
                  });
                }}
              >
                Apply bulk update
              </button>
            </>
          }
        >
          <p className="text-muted">
            Select saved rules and compare the proposed result. Nothing is saved
            until you apply. Original transcripts stay unchanged. You can undo
            the last bulk update here until another rule edit or leaving this
            page.
          </p>
          {stale && (
            <div role="alert">
              <p className="field-error">
                Saved rules changed while this preview was open. Refresh before
                applying.
              </p>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setBaseline(words.map((word) => ({ ...word })));
                  setSelected(
                    new Set(
                      [...selected].filter((id) =>
                        words.some((word) => word.id === id),
                      ),
                    ),
                  );
                  setError("");
                }}
              >
                Refresh preview
              </button>
            </div>
          )}
          <label className="field">
            Bulk action
            <select
              value={action}
              disabled={busy}
              onChange={(event) => setAction(event.target.value as BulkAction)}
            >
              <option value="enable">Enable selected rules</option>
              <option value="disable">Disable selected rules</option>
              <option value="remove">Remove selected rules</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-3.5">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                setSelected(new Set(baseline.map((word) => word.id)))
              }
            >
              Select all rules
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
          </div>
          <div className="max-h-[300px] overflow-auto border border-line rounded-panel">
            {baseline.map((word) => (
              <label
                key={word.id}
                className="flex items-start gap-3.5 p-3.5 border-b border-line last:border-0"
              >
                <input
                  type="checkbox"
                  checked={selected.has(word.id)}
                  disabled={busy}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(word.id);
                    else next.delete(word.id);
                    setSelected(next);
                  }}
                />
                <span className="min-w-0 break-words">
                  <strong>{word.term}</strong> <small>({ruleKind(word)})</small>
                  <span className="block text-muted text-[12px]">
                    {word.enabled ? "Enabled" : "Disabled"} →{" "}
                    {selected.has(word.id)
                      ? action === "remove"
                        ? "Removed"
                        : action === "enable"
                          ? "Enabled"
                          : "Disabled"
                      : "Unchanged"}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="caption">
            {selected.size} selected · {baseline.length} rules before →{" "}
            {proposed.length} after
          </p>
          <label className="field">
            Try a phrase (optional)
            <textarea
              value={phrase}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder="Type a phrase to compare rule output…"
            />
          </label>
          {phrase && (
            <div className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1">
              <div>
                <h3>Before update</h3>
                <p className="whitespace-pre-wrap break-words">
                  {personalize(phrase, baseline)}
                </p>
              </div>
              <div>
                <h3>After update</h3>
                <p className="whitespace-pre-wrap break-words">
                  {personalize(phrase, proposed)}
                </p>
              </div>
            </div>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
