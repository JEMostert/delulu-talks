import { useRef, useState } from "react";
import { LoaderCircle, Play, Square } from "lucide-react";
import { Alert } from "../ui";
import {
  VOICE_EMOTION_STYLES,
  VOICE_EVENT_TAGS,
  VOICE_LIMITS,
  VOICE_PAUSES,
  VOICE_PROSODY_STYLES,
  type VoiceEngineId,
  type VoiceSpeakResult,
} from "../../voice";

export const VOICE_SAMPLE =
  "Done. All 212 tests pass [chuckle], and the cache fix is merged. <whisper>Between us, that refactor was bigger than it looked.</whisper>";

const GROUPS = [
  { label: "Sounds", kind: "inline", tags: VOICE_EVENT_TAGS },
  { label: "Pauses", kind: "inline", tags: Object.keys(VOICE_PAUSES) },
  { label: "Styles", kind: "wrap", tags: VOICE_EMOTION_STYLES },
  { label: "Pacing", kind: "wrap", tags: VOICE_PROSODY_STYLES },
] as const;

/** What Kokoro cannot perform; whisper is approximated by speaking softly. */
function skippedBy(engine: VoiceEngineId, group: string, tag: string) {
  if (engine !== "kokoro") return false;
  return group === "Sounds" || (group === "Styles" && tag !== "whisper");
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** Type or paste markup, insert tags from chips, and hear the result. */
export function VoiceTryIt({
  engine,
  available,
  unavailableReason,
  speaking,
  onSpeak,
  onStop,
}: {
  engine: VoiceEngineId;
  available: boolean;
  unavailableReason: string;
  speaking: boolean;
  onSpeak: (text: string) => Promise<VoiceSpeakResult>;
  onStop: () => void;
}) {
  const [text, setText] = useState(VOICE_SAMPLE);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<VoiceSpeakResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const insert = (kind: "inline" | "wrap", tag: string) => {
    const element = field.current;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const selected = text.slice(start, end);
    const after = text.slice(end);
    let insertion: string;
    let cursorStart: number;
    let cursorEnd: number;
    if (kind === "inline") {
      const lead = before && !/\s$/.test(before) ? " " : "";
      const trail = after && !/^[\s.,!?;:]/.test(after) ? " " : "";
      insertion = `${lead}[${tag}]${trail}`;
      cursorStart = cursorEnd = start + insertion.length;
    } else {
      insertion = `<${tag}>${selected}</${tag}>`;
      cursorStart = start + tag.length + 2;
      cursorEnd = cursorStart + selected.length;
    }
    const next = (before + insertion + after).slice(
      0,
      VOICE_LIMITS.requestCharacters,
    );
    setText(next);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(cursorStart, cursorEnd);
    });
  };

  const speak = async () => {
    if (!text.trim()) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await onSpeak(text));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="voice-try">
      <label className="field voice-field">
        <span className="sr-only">Text to speak</span>
        <textarea
          ref={field}
          value={text}
          maxLength={VOICE_LIMITS.requestCharacters}
          spellCheck
          rows={4}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (available && !pending) void speak();
            }
          }}
        />
      </label>
      <div className="voice-tag-groups" aria-label="Insert speech tags">
        {GROUPS.map((group) => (
          <div className="voice-tag-group" key={group.label}>
            <span className="eyebrow">{group.label}</span>
            <div className="voice-chips">
              {group.tags.map((tag) => {
                const skipped = skippedBy(engine, group.label, tag);
                const label = group.kind === "inline" ? `[${tag}]` : `<${tag}>`;
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`voice-chip ${skipped ? "skipped" : ""}`}
                    title={
                      skipped
                        ? `Kokoro skips ${label}; Chatterbox Turbo performs it`
                        : group.kind === "wrap"
                          ? `Wrap the selection in ${label}`
                          : `Insert ${label}`
                    }
                    onClick={() => insert(group.kind, tag)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {engine === "kokoro" && (
        <p className="caption">
          Kokoro performs pauses and pacing. It skips sounds and emotions, and
          approximates a whisper by speaking softly. Switch to Chatterbox Turbo
          to hear them.
        </p>
      )}
      <div className="voice-try-actions">
        <button
          className="primary-button"
          disabled={!available || pending || !text.trim()}
          onClick={() => void speak()}
          aria-keyshortcuts="Control+Enter"
          title={available ? "Speak (Ctrl+Enter)" : unavailableReason}
        >
          {pending ? <LoaderCircle className="spin" /> : <Play />}
          {pending ? "Speaking…" : "Speak"}
        </button>
        <button
          className="secondary-button"
          disabled={!speaking && !pending}
          onClick={onStop}
        >
          <Square /> Stop
        </button>
        <span className="caption voice-count" aria-live="off">
          {text.length.toLocaleString()} /{" "}
          {VOICE_LIMITS.requestCharacters.toLocaleString()}
        </span>
      </div>
      {!available && <p className="caption">{unavailableReason}</p>}
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      {result && (
        <div className="voice-result" aria-live="polite">
          {result.outcome === "failed" ? (
            <Alert>{result.error ?? "Speech failed."}</Alert>
          ) : (
            <p className="caption">
              {result.outcome === "stopped" ? "Stopped" : "Spoken"} ·{" "}
              {seconds(result.durationMs)} s
            </p>
          )}
          {result.warnings.length > 0 && (
            <Alert tone="warning">
              <ul className="voice-notes">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Alert>
          )}
          {result.unsupported.length > 0 && (
            <p className="caption">
              Skipped by this voice: {result.unsupported.join(", ")}
            </p>
          )}
          {result.timestamps.length > 0 && (
            <ol className="voice-timestamps" aria-label="Spoken timing">
              {result.timestamps.map((stamp, index) => (
                <li key={index}>
                  <span className="voice-time">
                    {seconds(stamp.startMs)}–{seconds(stamp.endMs)} s
                  </span>
                  <span>{stamp.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
