import { useState } from "react";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Modal } from "./ui";
import type {
  MagicPreset,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
} from "../types";

export function RewriteDialog({
  text,
  baseline,
  status,
  onClose,
  onSetup,
  onRewrite,
  onApply,
}: {
  text: string;
  baseline: string;
  status?: MagicStatus;
  onClose: () => void;
  onSetup: () => void;
  onRewrite: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onApply: (result: MagicRewriteResult, source: string) => Promise<boolean>;
}) {
  const [source] = useState(text);
  const [expectedOutput] = useState(baseline);
  const [preset, setPreset] = useState<MagicPreset>("concise");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<MagicRewriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = status?.engine === "missing" || status?.engine === "error";
  return (
    <Modal
      title="Rewrite transcript"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          {result && (
            <button
              className="primary-button"
              disabled={busy || !result.text.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  if (await onApply(result, expectedOutput)) onClose();
                  else
                    setError(
                      "Could not apply this rewrite. The transcript may have changed; close this preview and review the current result.",
                    );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Use this rewrite
            </button>
          )}
        </>
      }
    >
      <p>
        Preview a change before using it. Original speech stays available and
        text shortcuts stay exactly as saved.
      </p>
      {missing ? (
        <div className="rewrite-setup my-3 rounded-panel border border-line p-3">
          <p>
            {status?.engine === "error"
              ? status.message
              : "Install a local writing model to use this optional tool. Dictation is ready without it."}
          </p>
          <button
            className="secondary-button"
            onClick={() => {
              onClose();
              onSetup();
            }}
          >
            Writing model setup
          </button>
        </div>
      ) : null}
      <div className="rewrite-options grid grid-cols-2 items-end gap-4">
        <label className="field">
          Style
          <select
            aria-label="Rewrite style"
            value={preset}
            disabled={busy}
            onChange={(e) => {
              setPreset(e.target.value as MagicPreset);
              setResult(null);
            }}
          >
            <option value="polish">Polish</option>
            <option value="concise">Shorten</option>
            <option value="structured">Organize</option>
            <option value="prompt">Build a prompt</option>
          </select>
        </label>
        <label className="field">
          Instructions <small>Optional</small>
          <input
            aria-label="Rewrite instructions"
            maxLength={4000}
            disabled={busy}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              setResult(null);
            }}
            placeholder="For example: format as a short email"
          />
        </label>
      </div>
      <div className="rewrite-comparison mb-4 mt-3 grid grid-cols-2 gap-4">
        <label className="field">
          Current text
          <textarea
            readOnly
            className="min-h-[200px] w-full"
            value={source}
            aria-label="Rewrite source"
          />
        </label>
        <label className="field">
          Preview
          <textarea
            aria-label="Rewrite preview"
            className="min-h-[200px] w-full"
            value={result?.text ?? ""}
            disabled={!result || busy}
            placeholder="Generate a preview to compare it here"
            onChange={(e) =>
              setResult(
                result
                  ? {
                      ...result,
                      text: e.target.value,
                      outputCharacters: e.target.value.length,
                    }
                  : null,
              )
            }
          />
        </label>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="secondary-button"
        disabled={busy || missing || source.length > 50_000}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setResult(
              await onRewrite({
                text: source,
                preset,
                instructions,
                allowInferences: false,
              }),
            );
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <LoaderCircle className="spin" /> : <WandSparkles />}
        {busy
          ? "Rewriting locally…"
          : result
            ? "Try again"
            : "Generate preview"}
      </button>
      {source.length > 50_000 && (
        <p className="field-error">
          This transcript exceeds the 50,000-character rewrite limit. Use a
          shorter excerpt in Writing.
        </p>
      )}
    </Modal>
  );
}
