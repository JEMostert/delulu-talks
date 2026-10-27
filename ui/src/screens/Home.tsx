import { insertMessage } from "../helpers";
import { Hero } from "../components/Hero";
import { Icon } from "../components/Icon";
import { Keys } from "../components/Controls";
import { Transcript } from "../components/Transcript";
import type { AppState } from "../state";

export function Home({ state }: { state: AppState }) {
  const {
    status,
    level,
    recovery,
    copy,
    setQuery,
    setPage,
    history,
    languages,
    insert,
  } = state;
  if (!status) return null;
  const go = (page: "History" | "Settings") => {
    setQuery("");
    setPage(page);
  };
  return (
    <div className="home">
      <Hero
        status={status}
        level={level}
        recovery={recovery}
        onSettings={() => go("Settings")}
      />
      <section className="recent" aria-labelledby="recent-title">
        <div className="recent-head">
          <h2 id="recent-title">Recent</h2>
          {history.length > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => go("History")}
            >
              All history
            </button>
          )}
        </div>
        {recovery?.insert.kind === "failed" && (
          <div className="recovery" role="alert">
            <div className="recovery-head">
              <Icon name="alert" size={17} />
              <span>{insertMessage(recovery.insert)}</span>
            </div>
            <p className="recovery-text">{recovery.entry.text}</p>
            <button
              type="button"
              className="button"
              onClick={() => void copy(recovery.entry.text)}
            >
              <Icon name="copy" size={16} />
              Copy text
            </button>
          </div>
        )}
        {history.length === 0 ? (
          <div className="empty empty-recent">
            <p className="empty-title">Nothing said yet</p>
            <p>
              Hold <Keys trigger={status.hotkey.trigger} /> in any app and say
              something. Your words show up here.
            </p>
          </div>
        ) : (
          <ol className="entries">
            {history.map((entry) => (
              <Transcript
                key={entry.id}
                entry={entry}
                languages={languages}
                onCopy={copy}
                onInsert={insert}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
