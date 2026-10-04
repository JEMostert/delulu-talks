import { IdentifierCorrection } from "./IdentifierCorrection";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import {
  emptyProjectVocabulary,
  type ProjectVocabularySnapshot,
} from "../projectVocabulary";

export function ProjectVocabulary() {
  const [scope, setScope] = useState(emptyProjectVocabulary);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    void bridge
      .getProjectVocabulary()
      .then((value) => {
        if (generation.current === request) setScope(value);
      })
      .catch(() => {
        if (generation.current === request)
          setMessage("Could not read the selected repository scope.");
      });
    return () => {
      generation.current += 1;
    };
  }, []);

  async function run(action: () => Promise<ProjectVocabularySnapshot>) {
    const request = ++generation.current;
    setBusy(true);
    setMessage(null);
    try {
      const value = await action();
      if (generation.current === request) {
        setScope(value);
        setFilter("");
      }
    } catch (error) {
      if (generation.current === request)
        setMessage(
          error instanceof Error ? error.message : "Repository scan failed.",
        );
    } finally {
      // Hidden pages run effect cleanups; the button must not stay disabled.
      setBusy(false);
    }
  }
  const matches = scope.symbols.filter((symbol) =>
    symbol.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  return (
    <section
      className="rounded-panel border border-line bg-surface p-4"
      aria-label="Project vocabulary"
    >
      <h2 className="text-[14px] font-semibold">Project vocabulary</h2>
      <p className="mt-2 text-[12px] text-muted">
        Select a local Git repository to collect declared symbol names for this
        session. Source bodies are read locally and discarded. Symbols stay
        separate from global corrections, are never sent to a model
        automatically, and clear when the app exits.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="tool-button"
          disabled={busy}
          onClick={() => void run(() => bridge.selectProjectVocabulary())}
        >
          Select repository
        </button>
        <button
          className="tool-button"
          disabled={busy || !scope.repository}
          onClick={() => void run(() => bridge.refreshProjectVocabulary())}
        >
          Refresh symbols
        </button>
        <button
          className="tool-button"
          disabled={busy || !scope.repository}
          onClick={() => void run(() => bridge.clearProjectVocabulary())}
        >
          Clear scope
        </button>
      </div>
      <p className="mt-3 break-all text-[12px]" role="status">
        {busy
          ? "Reading local declarations…"
          : (scope.repository ?? "No repository selected")}
      </p>
      {message && (
        <p className="mt-2 text-[12px] text-danger" role="alert">
          {message}
        </p>
      )}
      {scope.repository && (
        <>
          <p className="mt-2 text-[12px] text-muted">
            {scope.symbols.length} symbols · {scope.filesScanned} files read
            {scope.truncated
              ? " · Scan limit reached; results are partial"
              : ""}
          </p>
          {scope.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-[12px] text-muted">
              {scope.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <label className="mt-3 block text-[12px]">
            Find a symbol in the selected repository
            <input
              className="mt-1 w-full bg-input p-2"
              value={filter}
              maxLength={128}
              disabled={busy}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div
            className="mt-2 flex max-h-56 flex-wrap gap-1 overflow-auto"
            aria-label="Scoped symbol names"
          >
            {matches.slice(0, 100).map((symbol) => (
              <button
                key={symbol}
                className="tool-button font-mono text-[11px]"
                disabled={busy}
                title={`Copy ${symbol}`}
                onClick={() => {
                  void bridge
                    .copyText(symbol)
                    .then(() => setMessage(`Copied ${symbol}`))
                    .catch(() => setMessage("Could not copy the symbol."));
                }}
              >
                {symbol}
              </button>
            ))}
          </div>
          <IdentifierCorrection
            key={scope.repository}
            scope={scope}
            disabled={busy}
            onChoose={(rawSpeech, symbol) =>
              void run(() =>
                bridge.chooseProjectIdentifier({
                  repository: scope.repository!,
                  rawSpeech,
                  symbol,
                }),
              )
            }
            onCopy={(symbol) => {
              void bridge
                .copyText(symbol)
                .then(() => setMessage(`Copied ${symbol}`))
                .catch(() => setMessage("Could not copy the identifier."));
            }}
          />
          <p className="mt-2 text-[11px] text-muted">
            Showing {Math.min(matches.length, 100)} of {matches.length} matching
            names. Choose a name to copy it; dictation is unchanged.
          </p>
        </>
      )}
    </section>
  );
}
