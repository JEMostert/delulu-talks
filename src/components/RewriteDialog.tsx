import { useEffect, useId, useRef, useState } from "react";
import { PipelineTimingDetails } from "./PipelineTimingDetails";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Modal } from "./ui";
import { MAX_REWRITE_INSTRUCTIONS, validateRewriteInstructions } from "../rewriteInstructions";
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
  sourceRevision = 0,
  sourceLanguage,
  status,
  onClose,
  onSetup,
  onRewrite,
  onCancelRewrite,
  onApply,
  visible = true,
  onBackground,
  onOperationState,
  contextLabel,
}: {
  text: string;
  baseline: string;
  sourceRevision?: number;
  sourceLanguage?: string;
  status?: MagicStatus;
  visible?: boolean;
  contextLabel?: string;
  onBackground?: () => void;
  onOperationState?: (phase: "draft" | "working" | "ready" | "error") => void;
  onClose: () => void;
  onSetup: () => void;
  onRewrite: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onApply: (result: MagicRewriteResult, source: string, sourceRevision: number) => Promise<boolean>;
  onCancelRewrite?: (operationId: string) => Promise<boolean>;
}) {
  const instructionHelpId = useId();
  const active = useRef(true);
  const requestGeneration = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const [source, setSource] = useState(text);
  const [expectedOutput, setExpectedOutput] = useState(baseline);
  const [expectedRevision, setExpectedRevision] = useState(sourceRevision);
  const [preset, setPreset] = useState<MagicPreset>("concise");
  const [instructions, setInstructions] = useState("");
  const [result, setResult] = useState<MagicRewriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    onOperationState?.(busy ? "working" : error ? "error" : result ? "ready" : "draft");
  }, [busy, error, result, onOperationState]);
  const closeDialog = () => {
    requestGeneration.current += 1;
    setBusy(false);
    setInstructions("");
    setResult(null);
    setError(null);
    onClose();
  };
  const presetDetails = REWRITE_PRESETS.find((item) => item.id === preset)!;
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const activeSession = useRef<{ id: string; cancelled: boolean } | null>(null);
  const cancelRewrite = useRef(onCancelRewrite);
  cancelRewrite.current = onCancelRewrite;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const session = activeSession.current;
      activeSession.current = null;
      if (session && !session.cancelled) {
        session.cancelled = true;
        const cancel = cancelRewrite.current;
        if (cancel) void Promise.resolve().then(() => cancel(session.id)).catch(() => undefined);
      }
    };
  }, []);

  async function generatePreview() {
    if (activeSession.current || busy || stale) return;
    const session = { id: crypto.randomUUID(), cancelled: false };
    activeSession.current = session;
    setBusy(true);
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await onRewrite({
        operationId: session.id,
        sourceLanguage,
        text: source,
        preset,
        instructions: validateRewriteInstructions(instructions),
        allowInferences: false,
      });
      if (mounted.current && activeSession.current === session && !session.cancelled) {
        setResult(preview);
      }
    } catch (reason) {
      if (mounted.current && activeSession.current === session && !session.cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mounted.current && activeSession.current === session && !session.cancelled) {
        activeSession.current = null;
        setGenerating(false);
        setBusy(false);
      }
    }
  }

  async function cancelPreview() {
    const session = activeSession.current;
    if (!session || session.cancelled || !onCancelRewrite) return;
    session.cancelled = true;
    setCancelling(true);
    setError(null);
    let cleanupFailed = false;
    try {
      await onCancelRewrite(session.id);
    } catch {
      cleanupFailed = true;
    } finally {
      if (mounted.current && activeSession.current === session) {
        activeSession.current = null;
        setGenerating(false);
        setCancelling(false);
        setBusy(false);
        setNotice(cleanupFailed
          ? "Preview request cancelled; runtime cleanup could not be confirmed."
          : "Preview request cancelled");
      }
    }
  }

  const missing = status?.engine === "missing" || status?.engine === "error";
  const stale = source !== text || expectedOutput !== baseline || sourceRevision !== expectedRevision;
  return (
    <Modal
      title="Rewrite transcript"
      visible={visible}
      busy={busy}
      onClose={closeDialog}
      footer={
        <>
          {onBackground && <button className="secondary-button" onClick={onBackground}>Continue in background</button>}
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
              disabled={busy || stale || !result.text.trim()}
              onClick={async () => {
                if (stale || busy) return;
                setBusy(true);
                setError(null);
                try {
                  if (await onApply(result, expectedOutput, expectedRevision)) closeDialog();
                  else
                    setError(
                      "Could not apply this rewrite. The transcript may have changed; close this preview and review the current result.",
                    );
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason));
                } finally {
                  if (mounted.current) setBusy(false);
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
      {contextLabel && <p className="caption">Rewriting: {contextLabel}. This session stays attached to this transcript when you navigate or open another card.</p>}
      {stale && (
        <div className="rewrite-setup my-3 rounded-panel border border-line p-3" role="alert">
          <p>The transcript changed after this preview opened. This preview cannot be applied. Refresh to use the current text and generate a new preview.</p>
          <button className="secondary-button" disabled={busy} onClick={() => {
            setSource(text);
            setExpectedOutput(baseline);
            setExpectedRevision(sourceRevision);
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
              : "Install a local rewrite model to use this optional tool. Dictation is ready without it."}
          </p>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              if (onBackground) onBackground();
              else closeDialog();
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
      {notice && <p role="status">{notice}</p>}
      <button
        className="secondary-button"
        disabled={busy || stale || missing || source.length > 50_000}
        onClick={generatePreview}
      >
        {generating ? <LoaderCircle className="spin" /> : <WandSparkles />}
        {generating
          ? cancelling ? "Cancelling preview…" : "Rewriting locally…"
          : result
            ? "Try again"
            : "Generate preview"}
      </button>
      {generating && onCancelRewrite && (
        <button
          className="secondary-button"
          disabled={cancelling}
          onClick={cancelPreview}
        >
          {cancelling ? "Cancelling preview…" : "Cancel rewrite"}
        </button>
      )}
      {source.length > 50_000 && (
        <p className="field-error">
          This transcript exceeds the 50,000-character rewrite limit. Shorten
          the transcript before rewriting it.
        </p>
      )}
      {result && <PipelineTimingDetails timings={result.timings} />}
    </Modal>
  );
}
