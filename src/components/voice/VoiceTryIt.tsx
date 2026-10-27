import { useState } from "react";
import { LoaderCircle, Play, Square } from "lucide-react";
import { Alert } from "../ui";
import {
  VOICE_LIMITS,
  type VoiceEngineId,
  type VoiceSpeakResult,
} from "../../voice";

const SAMPLE =
  "Done. All 212 tests pass [chuckle], and the cache fix is merged. <whisper>Between us, that refactor was bigger than it looked.</whisper>";

/** What happened to the last try, in one line. */
function resultLine(result: VoiceSpeakResult): string {
  const parts = [
    `${result.outcome === "stopped" ? "Stopped" : "Spoken"} · ${(result.durationMs / 1000).toFixed(1)} s`,
  ];
  if (result.unsupported.length)
    parts.push(`skipped ${result.unsupported.join(", ")}`);
  return parts.join(" · ");
}

/** Type or paste text with tags and hear it. */
export function VoiceTryIt({
  engine,
  unavailableReason,
  speaking,
  onSpeak,
  onStop,
}: {
  engine: VoiceEngineId;
  /** Why Speak is disabled; empty when speech can run. */
  unavailableReason: string;
  speaking: boolean;
  onSpeak: (text: string) => Promise<VoiceSpeakResult>;
  onStop: () => void;
}) {
  const [text, setText] = useState(SAMPLE);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<VoiceSpeakResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = !unavailableReason;

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

  const note = !available
    ? unavailableReason
    : result && result.outcome !== "failed"
      ? resultLine(result)
      : engine === "kokoro"
        ? "Tags like [laugh] or <whisper>…</whisper> come alive on Large."
        : "Tags like [laugh] or <whisper>…</whisper> come alive here.";

  return (
    <section className="pref-group">
      <h3>Try it</h3>
      <div className="pref-list siren-try">
        <label className="sr-only" htmlFor="siren-try-text">
          Text to speak
        </label>
        <textarea
          id="siren-try-text"
          value={text}
          maxLength={VOICE_LIMITS.requestCharacters}
          spellCheck
          rows={3}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (available && !pending) void speak();
            }
          }}
        />
        <div className="siren-try-actions">
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
          <p className="caption" aria-live="polite">
            {note}
          </p>
        </div>
        {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
        {result?.outcome === "failed" && (
          <Alert onDismiss={() => setResult(null)}>
            {result.error ?? "Speech failed."}
          </Alert>
        )}
        {result && result.warnings.length > 0 && (
          <Alert tone="warning" onDismiss={() => setResult(null)}>
            {result.warnings.join(" ")}
          </Alert>
        )}
      </div>
    </section>
  );
}
