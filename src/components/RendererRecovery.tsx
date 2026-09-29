import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import {
  boundedRecoveryCall,
  recoveryError,
  type RecoveryDraft,
} from "../rendererRecovery";
import type { RendererRecoveryState } from "../types";

/** Deliberately independent of the ordinary workspace and Diagnostics UI. */
export function RendererRecovery({
  error,
  componentStack,
  controllerFailed,
  drafts,
  localSavePending,
}: {
  error: string;
  componentStack: string;
  controllerFailed: boolean;
  drafts: RecoveryDraft[];
  localSavePending: boolean;
}) {
  const [state, setState] = useState<RendererRecoveryState | null>(null);
  const [stateError, setStateError] = useState("");
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState("");
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const diagnosticAttempt = useRef(0);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    heading.current?.focus();
    let pending = false;
    async function refreshState() {
      if (pending) return;
      pending = true;
      try {
        const next = await boundedRecoveryCall(
          bridge.getRendererRecoveryState(),
        );
        if (alive.current) {
          setState(next);
          setStateError("");
        }
      } catch (reason) {
        if (alive.current) {
          setState(null);
          setStateError(recoveryError(reason));
        }
      } finally {
        pending = false;
      }
    }
    void refreshState();
    const interval = setInterval(() => void refreshState(), 1_500);
    return () => {
      alive.current = false;
      clearInterval(interval);
      diagnosticAttempt.current += 1;
    };
  }, []);

  async function inspectDiagnostics() {
    const attempt = ++diagnosticAttempt.current;
    setChecking(true);
    setDiagnosticError("");
    try {
      const data = await boundedRecoveryCall(bridge.getDiagnostics());
      if (alive.current && attempt === diagnosticAttempt.current)
        setDiagnostics(JSON.stringify(data, null, 2));
    } catch (reason) {
      if (alive.current && attempt === diagnosticAttempt.current)
        setDiagnosticError(recoveryError(reason));
    } finally {
      if (alive.current && attempt === diagnosticAttempt.current)
        setChecking(false);
    }
  }

  async function action(operation: () => Promise<unknown>) {
    setActionBusy(true);
    setActionError("");
    try {
      await boundedRecoveryCall(operation());
    } catch (reason) {
      if (alive.current) setActionError(recoveryError(reason));
    } finally {
      if (alive.current) setActionBusy(false);
    }
  }

  async function copy(text: string, label: string) {
    setCopied("");
    await action(async () => {
      await bridge.copyText(text);
      if (alive.current) setCopied(label);
    });
  }

  return (
    <main className="h-[100dvh] overflow-y-auto bg-canvas p-6 text-ink max-[700px]:p-4">
      <div className="mx-auto flex max-w-[900px] flex-col gap-5">
        <section className="card">
          <span className="eyebrow">WORKSPACE RECOVERY</span>
          <h1 ref={heading} tabIndex={-1} className="mt-2 text-2xl">
            The workspace could not be displayed
          </h1>
          <p className="mt-3 text-muted">
            Saved transcripts, settings and installed runtimes are kept. Reload
            only when the current operation has finished.
          </p>
          {controllerFailed ? (
            <p className="mt-3 text-muted">
              The recording controller stopped. An unfinished microphone capture
              may have been interrupted. Submitted audio and model operations
              continue in the desktop process.
            </p>
          ) : (
            <p className="mt-3 text-muted">
              The recording controller and pending saves are still running. You
              can stop and save an active recording here.
            </p>
          )}
          <div
            role="alert"
            className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-line p-3"
          >
            {error || "Unknown renderer error"}
          </div>
          <div className="panel-actions mt-4 flex flex-wrap gap-3">
            {state?.canStopRecording && !controllerFailed && (
              <button
                className="secondary-button"
                disabled={actionBusy}
                onClick={() => void action(() => bridge.stopDictation())}
              >
                Stop and save recording
              </button>
            )}
            <button
              className="primary-button"
              disabled={!state?.canReload || actionBusy || localSavePending}
              onClick={() => void action(() => bridge.reloadWorkspace())}
            >
              Reload workspace
            </button>
            <button
              className="secondary-button"
              disabled={actionBusy}
              onClick={() =>
                void copy(
                  `${error}\n${componentStack}`,
                  "Renderer error copied",
                )
              }
            >
              Copy renderer error
            </button>
          </div>
          <p role="status" className="caption mt-3">
            {(localSavePending &&
              "Wait for pending settings changes to save before reloading.") ||
              stateError ||
              state?.reason ||
              (state?.canReload
                ? "Ready to reload. Copy any recent edits you need before reloading."
                : "Checking whether the workspace can reload…")}
          </p>
          {actionError && (
            <p role="alert" className="mt-3 whitespace-pre-wrap break-words">
              {actionError}
            </p>
          )}
          {copied && (
            <p role="status" className="caption mt-3">
              {copied}
            </p>
          )}
          {componentStack && (
            <details className="mt-4">
              <summary>Renderer details</summary>
              <pre className="mt-3 whitespace-pre-wrap break-words text-xs">
                {componentStack}
              </pre>
            </details>
          )}
        </section>
        {drafts.length > 0 && (
          <section className="card">
            <h2 className="text-lg">Recent text edits</h2>
            <p className="caption mt-2">
              These recent values are held in memory only, separate from
              diagnostics. They may include already saved edits. Reload clears
              this recovery copy.
            </p>
            {drafts.map((draft, index) => (
              <div key={index} className="mt-4">
                <label className="field">
                  <span>{draft.label}</span>
                  <textarea
                    aria-label={`Recovered ${draft.label} ${index + 1}`}
                    readOnly
                    value={draft.text}
                  />
                </label>
                <button
                  className="secondary-button"
                  disabled={actionBusy}
                  onClick={() => void copy(draft.text, "Text edit copied")}
                >
                  Copy text edit {index + 1}
                </button>
              </div>
            ))}
          </section>
        )}
        <section className="card">
          <h2 className="text-lg">Diagnostics</h2>
          <p className="caption mt-2">
            Inspect the desktop services without reopening the failed workspace.
          </p>
          <div className="panel-actions mt-4 flex flex-wrap gap-3">
            <button
              className="secondary-button"
              disabled={checking}
              onClick={() => void inspectDiagnostics()}
            >
              {checking ? "Checking diagnostics…" : "Check diagnostics"}
            </button>
            {diagnostics && (
              <button
                className="secondary-button"
                disabled={actionBusy}
                onClick={() => void copy(diagnostics, "Diagnostics copied")}
              >
                Copy diagnostics
              </button>
            )}
          </div>
          {diagnosticError && (
            <p role="alert" className="mt-3 whitespace-pre-wrap break-words">
              {diagnosticError}
            </p>
          )}
          {diagnostics && (
            <pre
              aria-label="Recovery diagnostics"
              className="mt-4 whitespace-pre-wrap break-words text-xs"
            >
              {diagnostics}
            </pre>
          )}
        </section>
      </div>
    </main>
  );
}
