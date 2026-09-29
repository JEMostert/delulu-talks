import { useState } from "react";
import { LoaderCircle, WandSparkles } from "lucide-react";
import { Modal } from "./ui";
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
  const [contextEnabled, setContextEnabled] = useState(false);
  const [language, setLanguage] = useState("");
  const [fileType, setFileType] = useState("");
  const [selection, setSelection] = useState("");
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
      <details className="my-3">
        <summary>Optional language and editor context</summary>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={contextEnabled} disabled={busy}
            onChange={(event) => { setContextEnabled(event.target.checked); setResult(null); }} />
          Include the context below for this local rewrite
        </label>
        <p className="caption mt-2">Only context you enter is used. It is not saved with the transcript.
          Fenced code/terminal blocks and indented code in the source stay exact.</p>
        {contextEnabled && <div className="grid gap-3 mt-3">
          <label className="field">Language
            <input aria-label="Rewrite context language" maxLength={80} disabled={busy} value={language}
              placeholder="For example: Dutch prose, TypeScript identifiers"
              onChange={(event) => { setLanguage(event.target.value); setResult(null); }} />
          </label>
          <label className="field">File type
            <input aria-label="Rewrite context file type" maxLength={80} disabled={busy} value={fileType}
              placeholder="For example: Markdown"
              onChange={(event) => { setFileType(event.target.value); setResult(null); }} />
          </label>
          <label className="field">Selection context <small>Read-only reference</small>
            <textarea aria-label="Rewrite selection context" maxLength={4000} disabled={busy} value={selection}
              className="w-full min-h-[90px] font-mono"
              onChange={(event) => { setSelection(event.target.value); setResult(null); }} />
          </label>
        </div>}
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
                context: contextEnabled ? { language, fileType, selection } : undefined,
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
