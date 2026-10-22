import type { VoiceUtteranceSummary } from "../../voice";

const OUTCOMES: Record<VoiceUtteranceSummary["outcome"], [string, string]> = {
  queued: ["Waiting", "neutral"],
  speaking: ["Speaking", ""],
  spoken: ["Spoken", "success"],
  stopped: ["Stopped", "neutral"],
  interrupted: ["Interrupted", "neutral"],
  failed: ["Failed", "danger"],
};

function speaker(item: VoiceUtteranceSummary): string {
  if (item.agent) return item.agent;
  return item.source === "clipboard"
    ? "Clipboard"
    : item.source === "agent"
      ? "Agent"
      : "You";
}

/** What was said recently, by whom; kept for this session only. */
export function VoiceRecent({ items }: { items: VoiceUtteranceSummary[] }) {
  return (
    <section className="pref-group">
      <h3>Recently spoken</h3>
      {items.length === 0 ? (
        <p className="pref-note">
          Nothing spoken yet. Briefings from your agents appear here.
        </p>
      ) : (
        <ol className="pref-list voice-recent">
          {items.map((item) => {
            const [label, tone] = OUTCOMES[item.outcome];
            return (
              <li key={item.id}>
                <div className="voice-recent-meta">
                  <time dateTime={new Date(item.at).toISOString()}>
                    {new Date(item.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <strong>{speaker(item)}</strong>
                  <span className={`badge ${tone}`}>{label}</span>
                  {item.durationMs > 0 && (
                    <span className="caption">
                      {(item.durationMs / 1000).toFixed(1)} s
                    </span>
                  )}
                </div>
                <p>{item.text}</p>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 0 && (
        <p className="pref-note">Kept for this session only.</p>
      )}
    </section>
  );
}
