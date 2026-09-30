import { useId, useState } from "react";
import { rankIdentifierCandidates } from "../identifierCandidates";
import type { ProjectVocabularySnapshot } from "../projectVocabulary";

export function IdentifierCorrection({
  scope,
  disabled,
  onChoose,
  onCopy,
}: {
  scope: ProjectVocabularySnapshot;
  disabled: boolean;
  onChoose: (rawSpeech: string, symbol: string) => void;
  onCopy: (symbol: string) => void;
}) {
  const id = useId();
  const [rawSpeech, setRawSpeech] = useState("");
  const candidates = rankIdentifierCandidates(rawSpeech, scope.symbols);
  return (
    <div className="mt-4 border-t border-line pt-3 text-[12px]">
      <h3 className="font-semibold">Identifier candidates</h3>
      <p className="mt-1 text-muted">
        Enter an identifier phrase from your transcript. Suggestions compare
        spelling against this repository only. Choose deliberately; raw speech
        and transcripts stay unchanged.
      </p>
      <label htmlFor={id} className="mt-3 block">
        Raw spoken phrase
      </label>
      <input
        id={id}
        className="mt-1 w-full bg-input p-2"
        maxLength={256}
        disabled={disabled}
        value={rawSpeech}
        onChange={(event) => setRawSpeech(event.target.value)}
      />
      {rawSpeech.trim() && candidates.length === 0 && (
        <p className="mt-2 text-muted" role="status">
          No close scoped symbol found. Keep the raw phrase or correct it
          manually.
        </p>
      )}
      <ul className="mt-2 grid gap-2">
        {candidates.map((candidate) => (
          <li
            key={candidate.symbol}
            className="flex flex-wrap items-center gap-2"
          >
            <code className="break-all">{candidate.symbol}</code>
            <span className="text-muted">{candidate.reason}</span>
            <button
              className="tool-button ml-auto"
              disabled={disabled}
              onClick={() => onChoose(rawSpeech, candidate.symbol)}
            >
              Record choice
            </button>
          </li>
        ))}
      </ul>
      <details className="mt-3">
        <summary className="cursor-pointer">
          Chosen replacements ({scope.choices.length})
        </summary>
        <p className="mt-2 text-muted">
          Last 50 choices for this scope, held only in memory. Refresh, switch,
          clear or app exit removes them. Nothing is replaced automatically.
        </p>
        <ul className="mt-2 grid gap-2">
          {scope.choices.map((choice) => (
            <li key={choice.id} className="flex flex-wrap items-center gap-2">
              <span className="whitespace-pre-wrap break-all">
                {choice.rawSpeech}
              </span>
              <span aria-hidden="true">→</span>
              <code className="break-all">{choice.symbol}</code>
              <button
                className="tool-button ml-auto"
                disabled={disabled}
                onClick={() => onCopy(choice.symbol)}
              >
                Copy chosen identifier
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
