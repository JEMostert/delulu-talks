import { useState } from "react";
import { personalize } from "../personalization";
import type { CustomWord, TranscriptRecord } from "../types";

const excerptLength = 4000;

function Example({
  label,
  text,
  rule,
}: {
  label: string;
  text: string;
  rule: CustomWord;
}) {
  const source = text.slice(0, excerptLength);
  const result = personalize(source, [rule]);
  return (
    <section className="border border-line rounded-panel p-3.5">
      <h3>{label}</h3>
      {text.length > excerptLength && (
        <p className="caption">Showing the first {excerptLength} characters.</p>
      )}
      <div className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1">
        <div>
          <h4>Original</h4>
          <p className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto">
            {source || "No source text."}
          </p>
        </div>
        <div>
          <h4>With this word</h4>
          <p className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto">
            {result || "No source text."}
          </p>
        </div>
      </div>
      {source === result && <p className="caption">No change here.</p>}
    </section>
  );
}

export function SuggestedRulePreview({
  source,
  examples = [],
  heard,
  correct,
}: {
  source: TranscriptRecord;
  examples?: TranscriptRecord[];
  heard: string;
  correct: string;
}) {
  const [consent, setConsent] = useState(false);
  const rule: CustomWord = {
    id: "suggested-rule-preview",
    kind: "correction",
    term: correct.trim(),
    soundsLike: heard.trim(),
    replacement: "",
    enabled: true,
  };
  const valid = rule.term && rule.soundsLike && rule.term !== rule.soundsLike;
  const recent = consent
    ? examples
        .filter((record) => record.id !== source.id)
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 5)
    : [];
  return (
    <div className="content-stack">
      {!valid ? (
        <p className="caption">Enter two different phrases to see a preview.</p>
      ) : (
        <Example label="This transcript" text={source.text} rule={rule} />
      )}
      <label className="flex items-start gap-3.5">
        <input
          type="checkbox"
          checked={consent}
          disabled={!examples.some((record) => record.id !== source.id)}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>
          Also preview on up to five recent transcripts. Nothing is saved.
        </span>
      </label>
      {!examples.some((record) => record.id !== source.id) && (
        <p className="caption">No other transcripts to preview.</p>
      )}
      {consent &&
        valid &&
        recent.map((record, index) => (
          <Example
            key={record.id}
            label={`Recent example ${index + 1}`}
            text={record.text}
            rule={rule}
          />
        ))}
    </div>
  );
}
