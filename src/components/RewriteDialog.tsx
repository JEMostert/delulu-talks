import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Modal } from "./ui";
import { MAX_REWRITE_INSTRUCTIONS, validateRewriteInstructions } from "../rewriteInstructions";
import { REWRITE_PRESETS } from "../rewritePresets";
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
  const instructionHelpId = useId();
  const active = useRef(true);
  const requestGeneration = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const [source] = useState(text);
  const [expectedOutput] = useState(baseline);
  const [preset, setPreset] = useState<MagicPreset>("concise");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<MagicRewriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeDialog = () => {
    requestGeneration.current += 1;
    setBusy(false);
    setInstructions("");
    setResult(null);
    setError(null);
    onClose();
  };
  const presetDetails = REWRITE_PRESETS.find((item) => item.id === preset)!;
  const missing = status?.engine === "missing" || status?.engine === "error";
  return (
    <Modal
      title="Rewrite transcript"
      busy={busy}
      onClose={closeDialog}
      footer={
        <>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={closeDialog}
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
                  if (await onApply(result, expectedOutput)) closeDialog();
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
              closeDialog();
              onSetup();
            }}
          >
            Set up rewriting in Models
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
              setError(null);
            }}
          >
            {REWRITE_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Instructions for this rewrite <small>Optional</small>
          <textarea
            aria-label="Rewrite instructions"
            aria-describedby={instructionHelpId}
            rows={3}
            maxLength={MAX_REWRITE_INSTRUCTIONS}
            disabled={busy}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              setResult(null);
              setError(null);
            }}
            placeholder="For example: format as a short email"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p id={instructionHelpId} className="flex-1 text-xs text-muted">
          Kept for retries in this dialog and discarded when you close it.
          Never saved as a writing preference or transcript metadata. Instructions
          request tone or format; they do not guarantee factual accuracy. Compare
          the full preview before applying it. Saved shortcut blocks stay protected.
        </p>
        <span className="text-xs text-muted">{instructions.length.toLocaleString()} / 4,000</span>
        <button className="secondary-button" disabled={busy || !instructions} onClick={() => {
          setInstructions("");
          setResult(null);
          setError(null);
        }}>Clear instructions</button>
      </div>
      <p className="mt-3" aria-live="polite">{presetDetails.description}</p>
      <details className="my-3 rounded-panel border border-line p-3">
        <summary>Illustrative example: {presetDetails.label}</summary>
        <p className="my-2">Written examples only; your local model's output may differ. Generate a preview to rewrite your transcript.</p>
        <p><strong>Example source</strong></p>
        <p className="whitespace-pre-wrap break-words">{presetDetails.exampleSource}</p>
        <p className="mt-2"><strong>Example output</strong></p>
        <p className="whitespace-pre-wrap break-words">{presetDetails.exampleOutput}</p>
      </details>
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
          const generation = ++requestGeneration.current;
          setBusy(true);
          setError(null);
          try {
            const rewritten = await onRewrite({
              text: source,
              preset,
              instructions: validateRewriteInstructions(instructions),
              allowInferences: false,
            });
            if (active.current && requestGeneration.current === generation) setResult(rewritten);
          } catch (reason) {
            if (active.current && requestGeneration.current === generation) setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            if (active.current && requestGeneration.current === generation) setBusy(false);
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
          This transcript exceeds the 50,000-character rewrite limit. Shorten
          the transcript before rewriting it.
        </p>
      )}
    </Modal>
  );
}
