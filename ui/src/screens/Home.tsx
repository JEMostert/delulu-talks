import * as ipc from "../ipc";
import { insertMessage } from "../helpers";
import { Transcript } from "../components/Transcript";
import type { AppState } from "../state";
const phases: Record<ipc.Phase, string> = {
  needsSetup: "Getting ready",
  loadingModel: "Preparing",
  idle: "Ready to listen",
  recording: "Listening",
  transcribing: "Turning speech into text",
  error: "Needs attention",
};
export function Home({ state }: { state: AppState }) {
  const {
    status,
    trigger,
    recovery,
    copy,
    setQuery,
    setPage,
    history,
    languages,
    insert,
  } = state;
  if (!status) return null;
  return (
    <>
      <div className="page-heading">
        <h1>Home</h1>
        <p>Your space to speak freely.</p>
      </div>
      <section className={`status status-${status.phase}`}>
        <div className="status-orb" aria-hidden="true">
          <span />
        </div>
        <div>
          <p className="status-label">Dictation</p>
          <h2>{phases[status.phase]}</h2>
          <p>
            {status.message ||
              (status.phase === "idle"
                ? `Hold ${trigger} to speak, or tap to start and stop.`
                : status.hotkey.error || "")}
          </p>
        </div>
      </section>
      {recovery?.insert.kind === "failed" && (
        <section className="recovery">
          <h2>Recover transcript</h2>
          <p>{recovery.entry.text}</p>
          <p className="error">{insertMessage(recovery.insert)}</p>
          <button onClick={() => void copy(recovery.entry.text)}>Copy</button>
        </section>
      )}
      <div className="section-title">
        <h2>Recent transcripts</h2>
        <button
          className="link"
          onClick={() => {
            setQuery("");
            setPage("History");
          }}
        >
          View history
        </button>
      </div>
      {history.length === 0 ? (
        <p className="empty">Your recent transcripts will appear here.</p>
      ) : (
        history.map((entry) => (
          <Transcript
            key={entry.id}
            entry={entry}
            languages={languages}
            onCopy={copy}
            onInsert={insert}
          />
        ))
      )}
    </>
  );
}
