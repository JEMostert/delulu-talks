import { useEffect, useRef, useState } from "react";
import { PipelineTimingDetails } from "./PipelineTimingDetails";
import { bridge } from "../bridge";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Alert, Modal } from "./ui";
import {
  MAX_REWRITE_INSTRUCTIONS,
  validateRewriteInstructions,
} from "../rewriteInstructions";
import { isMagicPreset, REWRITE_PRESETS } from "../rewritePresets";
import { RewriteDiff } from "./RewriteDiff";
import { RewriteWarnings } from "./RewriteWarnings";
import type {
  MagicPreset,
  MagicRewriteRequest,
  MagicRewriteResult,
  MagicStatus,
} from "../types";

const MAX_REWRITE_SOURCE = 50_000;

export function RewriteDialog({
  text,
  title = "Rewrite transcript",
  baseline,
  sourceRevision = 0,
  sourceLanguage,
  status,
  defaultPreset,
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
  title?: string;
  baseline: string;
  sourceRevision?: number;
  sourceLanguage?: string;
  status?: MagicStatus;
  /** Initial style, usually the one chosen in Settings. */
  defaultPreset?: MagicPreset;
  visible?: boolean;
  contextLabel?: string;
  onBackground?: () => void;
  onOperationState?: (phase: "draft" | "working" | "ready" | "error") => void;
  onClose: () => void;
  onSetup: () => void;
  onRewrite: (request: MagicRewriteRequest) => Promise<MagicRewriteResult>;
  onApply: (
    result: MagicRewriteResult,
    source: string,
    sourceRevision: number,
  ) => Promise<boolean>;
  onCancelRewrite?: (operationId: string) => Promise<boolean>;
}) {
  const [source, setSource] = useState(text);
  const [expectedOutput, setExpectedOutput] = useState(baseline);
  const [expectedRevision, setExpectedRevision] = useState(sourceRevision);
  const [preset, setPreset] = useState<MagicPreset>(
    isMagicPreset(defaultPreset) ? defaultPreset : "concise",
  );
  const [instructions, setInstructions] = useState("");
  const [contextEnabled, setContextEnabled] = useState(false);
  const [language, setLanguage] = useState("");
  const [fileType, setFileType] = useState("");
  const [selection, setSelection] = useState("");
  const [result, setResult] = useState<MagicRewriteResult | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    onOperationState?.(
      busy ? "working" : error ? "error" : result ? "ready" : "draft",
    );
  }, [busy, error, result, onOperationState]);
  const closeDialog = () => {
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
    // A hidden <Activity> runs this cleanup and cancels the request but keeps
    // state; when shown again, release controls the cancelled request held.
    if (!activeSession.current) {
      setBusy(false);
      setGenerating(false);
      setCancelling(false);
    }
    return () => {
      mounted.current = false;
      const session = activeSession.current;
      activeSession.current = null;
      if (session && !session.cancelled) {
        session.cancelled = true;
        const cancel = cancelRewrite.current;
        if (cancel)
          void Promise.resolve()
            .then(() => cancel(session.id))
            .catch(() => undefined);
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
        context: contextEnabled ? { language, fileType, selection } : undefined,
        instructions:
          preset === "spoken-corrections"
            ? undefined
            : validateRewriteInstructions(instructions),
        allowInferences: false,
      });
      if (
        mounted.current &&
        activeSession.current === session &&
        !session.cancelled
      ) {
        setResult(preview);
        setShowOriginal(false);
      }
    } catch (reason) {
      if (
        mounted.current &&
        activeSession.current === session &&
        !session.cancelled
      ) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (
        mounted.current &&
        activeSession.current === session &&
        !session.cancelled
      ) {
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
        setNotice(
          cleanupFailed
            ? "Rewrite stopped; runtime cleanup could not be confirmed."
            : "Rewrite stopped.",
        );
      }
    }
  }

  const missing = status?.engine === "missing" || status?.engine === "error";
  const stale =
    source !== text ||
    expectedOutput !== baseline ||
    sourceRevision !== expectedRevision;
  const tooLong = source.length > MAX_REWRITE_SOURCE;
  const corrections = preset === "spoken-corrections";
  // Any change to the request invalidates the preview it produced.
  const resetPreview = () => {
    setResult(null);
    setError(null);
  };
  return (
    <Modal
      title={title}
      visible={visible}
      busy={busy}
      onClose={closeDialog}
      className="rewrite-dialog"
      footer={
        <>
          {onBackground && (
            <button className="text-button mr-auto" onClick={onBackground}>
              Continue in background
            </button>
          )}
          <button
            className="secondary-button"
            disabled={busy}
            onClick={closeDialog}
          >
            Cancel
          </button>
          {result && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={async () => {
                try {
                  await bridge.copyText(result.text);
                  setNotice("Rewrite copied.");
                } catch (reason) {
                  setError(String(reason));
                }
              }}
            >
              Copy
            </button>
          )}
          {result && (
            <button
              className="primary-button"
              disabled={busy || stale || !result.text.trim()}
              onClick={async () => {
                if (stale || busy) return;
                setBusy(true);
                setError(null);
                try {
                  if (await onApply(result, expectedOutput, expectedRevision))
                    closeDialog();
                  else
                    setError(
                      "Couldn’t apply this rewrite. The transcript may have changed.",
                    );
                } catch (reason) {
                  setError(
                    reason instanceof Error ? reason.message : String(reason),
                  );
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
      {contextLabel && <p className="caption">{contextLabel}</p>}
      {(missing || stale) && (
        <div className="mb-4 grid gap-2">
          {missing && (
            <Alert
              tone={status?.engine === "error" ? "danger" : "info"}
              action={
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => {
                    if (onBackground) onBackground();
                    else closeDialog();
                    onSetup();
                  }}
                >
                  Set up rewriting
                </button>
              }
            >
              {status?.engine === "error"
                ? status.message
                : "Rewriting needs a local model (about 4.5 GB)."}
            </Alert>
          )}
          {stale && (
            <Alert
              tone="warning"
              action={
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setSource(text);
                    setExpectedOutput(baseline);
                    setExpectedRevision(sourceRevision);
                    resetPreview();
                  }}
                >
                  Refresh
                </button>
              }
            >
              The transcript changed since this preview opened.
            </Alert>
          )}
        </div>
      )}
      {!missing && (
        <>
          <div className="rewrite-bar flex flex-wrap items-end gap-2">
            <label className="field mt-0 min-w-48 flex-1">
              Style
              <select
                aria-label="Rewrite style"
                value={preset}
                disabled={busy}
                onChange={(e) => {
                  setPreset(e.target.value as MagicPreset);
                  resetPreview();
                }}
              >
                {REWRITE_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={result ? "secondary-button" : "primary-button"}
              disabled={busy || stale || !source.trim() || tooLong}
              onClick={generatePreview}
            >
              {generating ? (
                <LoaderCircle className="spin" />
              ) : (
                <WandSparkles />
              )}
              {generating ? "Rewriting…" : result ? "Try again" : "Rewrite"}
            </button>
            {generating && onCancelRewrite && (
              <button
                className="secondary-button"
                disabled={cancelling}
                onClick={cancelPreview}
              >
                {cancelling ? "Stopping…" : "Stop"}
              </button>
            )}
          </div>
          <textarea
            aria-label="Rewrite instructions"
            className="mt-2 w-full"
            rows={2}
            maxLength={MAX_REWRITE_INSTRUCTIONS}
            disabled={busy || corrections}
            value={instructions}
            placeholder={
              corrections
                ? "This style takes no instructions"
                : "Optional: e.g. format as a short email"
            }
            onChange={(e) => {
              setInstructions(e.target.value);
              resetPreview();
            }}
          />
          <details className="disclosure mt-3">
            <summary>More options</summary>
            <p className="caption">
              <strong>{presetDetails.label}:</strong>{" "}
              {presetDetails.description}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
              <div className="min-w-0">
                <strong>Example</strong>
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {presetDetails.exampleSource}
                </p>
              </div>
              <div className="min-w-0">
                <strong>Becomes</strong>
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {presetDetails.exampleOutput}
                </p>
              </div>
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={contextEnabled}
                disabled={busy}
                onChange={(event) => {
                  setContextEnabled(event.target.checked);
                  setResult(null);
                }}
              />
              Use this context
            </label>
            {contextEnabled && (
              <div className="grid gap-3">
                <label className="field">
                  Language
                  <input
                    aria-label="Rewrite context language"
                    maxLength={80}
                    disabled={busy}
                    value={language}
                    placeholder="For example: Dutch prose, TypeScript identifiers"
                    onChange={(event) => {
                      setLanguage(event.target.value);
                      setResult(null);
                    }}
                  />
                </label>
                <label className="field">
                  File type
                  <input
                    aria-label="Rewrite context file type"
                    maxLength={80}
                    disabled={busy}
                    value={fileType}
                    placeholder="For example: Markdown"
                    onChange={(event) => {
                      setFileType(event.target.value);
                      setResult(null);
                    }}
                  />
                </label>
                <label className="field">
                  Selection context <small>Read-only reference</small>
                  <textarea
                    aria-label="Rewrite selection context"
                    maxLength={4000}
                    disabled={busy}
                    value={selection}
                    onChange={(event) => {
                      setSelection(event.target.value);
                      setResult(null);
                    }}
                  />
                </label>
              </div>
            )}
            <p className="caption mt-4">
              Instructions: {instructions.length.toLocaleString()} /{" "}
              {MAX_REWRITE_INSTRUCTIONS.toLocaleString()} characters
            </p>
            {result && <PipelineTimingDetails timings={result.timings} />}
          </details>
        </>
      )}
      <div className="field">
        {result ? (
          <div
            className="segmented self-start"
            role="group"
            aria-label="Text shown"
          >
            <button
              type="button"
              aria-pressed={!showOriginal}
              onClick={() => setShowOriginal(false)}
            >
              Rewrite
            </button>
            <button
              type="button"
              aria-pressed={showOriginal}
              onClick={() => setShowOriginal(true)}
            >
              Original
            </button>
          </div>
        ) : (
          <span>Current text</span>
        )}
        {result && !showOriginal ? (
          <textarea
            aria-label="Rewrite preview"
            className="min-h-[180px] w-full font-normal"
            value={result.text}
            disabled={busy}
            onChange={(e) =>
              setResult({
                ...result,
                text: e.target.value,
                outputCharacters: e.target.value.length,
              })
            }
          />
        ) : (
          <textarea
            readOnly
            aria-label="Rewrite source"
            className="min-h-[180px] w-full font-normal"
            value={source}
          />
        )}
      </div>
      <div className="mt-2">
        {tooLong && (
          <p className="field-error">
            Too long to rewrite (50,000 characters at most).
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="caption" role="status">
            {notice}
          </p>
        )}
      </div>
      {result && (
        <div className="mt-4">
          <RewriteDiff source={source} preview={result.text} />
          <RewriteWarnings source={source} preview={result.text} />
        </div>
      )}
    </Modal>
  );
}
