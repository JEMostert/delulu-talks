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
        <p className="caption">
          Preview shows the first {excerptLength} characters only.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1">
        <div>
          <h4>Original</h4>
          <p className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto">
            {source || "No source text."}
          </p>
        </div>
        <div>
          <h4>With suggested rule</h4>
          <p className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto">
            {result || "No source text."}
          </p>
        </div>
      </div>
      {source === result && (
        <p className="caption">No change in this example.</p>
      )}
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
      <p className="text-muted">
        Preview this suggested rule on original speech text. Other saved rules
        are excluded from this comparison. Nothing here changes existing
        transcripts or saves a rule.
      </p>
      {!valid ? (
        <p className="caption">
          Enter different recognized and replacement phrases to preview.
        </p>
      ) : (
        <Example label="Source transcript" text={source.text} rule={rule} />
      )}
      <label className="flex items-start gap-3.5">
        <input
          type="checkbox"
          checked={consent}
          disabled={!examples.some((record) => record.id !== source.id)}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>
          Use up to five recent available transcripts as examples for this
          preview only. Their text stays local and is not copied into the rule.
        </span>
      </label>
      {!examples.some((record) => record.id !== source.id) && (
        <p className="caption">
          No other examples are available, or history is currently disabled.
        </p>
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
