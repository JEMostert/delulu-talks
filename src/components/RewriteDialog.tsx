import { useState } from "react";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Modal } from "./ui";
import { REWRITE_PRESETS } from "../rewritePresets";
import { RewriteDiff } from "./RewriteDiff";
import { RewriteWarnings } from "./RewriteWarnings";
import type {
  MagicPreset,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
} from "../types";

export function RewriteDialog({
  text,
  baseline,
  sourceLanguage,
  status,
  onClose,
  onSetup,
  onRewrite,
  onApply,
}: {
  text: string;
  baseline: string;
  sourceLanguage?: string;
  status?: MagicStatus;
  onClose: () => void;
  onSetup: () => void;
  onRewrite: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onApply: (result: MagicRewriteResult, source: string) => Promise<boolean>;
}) {
  const [source, setSource] = useState(text);
  const [expectedOutput, setExpectedOutput] = useState(baseline);
  const [preset, setPreset] = useState<MagicPreset>("concise");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<MagicRewriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presetDetails = REWRITE_PRESETS.find((item) => item.id === preset)!;
  const missing = status?.engine === "missing" || status?.engine === "error";
  const stale = source !== text || expectedOutput !== baseline;
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
              disabled={busy || stale || !result.text.trim()}
              onClick={async () => {
                if (stale || busy) return;
                setBusy(true);
                setError(null);
                try {
                  if (await onApply(result, expectedOutput)) onClose();
                  else
                    setError(
                      "Could not apply this rewrite. The transcript may have changed; close this preview and review the current result.",
                    );
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
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
      {stale && (
        <div className="rewrite-setup my-3 rounded-panel border border-line p-3" role="alert">
          <p>The transcript changed after this preview opened. This preview cannot be applied. Refresh to use the current text and generate a new preview.</p>
          <button className="secondary-button" disabled={busy} onClick={() => {
            setSource(text);
            setExpectedOutput(baseline);
            setResult(null);
            setError(null);
          }}>Refresh rewrite source</button>
        </div>
      )}
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
            }}
          >
            {REWRITE_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
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
      {result && (
        <>
          <RewriteWarnings source={source} preview={result.text} />
          <RewriteDiff source={source} preview={result.text} />
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="secondary-button"
        disabled={busy || stale || missing || source.length > 50_000}
        onClick={async () => {
          if (busy || stale) return;
          setBusy(true);
          setError(null);
          try {
            setResult(
              await onRewrite({
                text: source,
                sourceLanguage,
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
          This transcript exceeds the 50,000-character rewrite limit. Shorten
          the transcript before rewriting it.
        </p>
      )}
    </Modal>
  );
}
