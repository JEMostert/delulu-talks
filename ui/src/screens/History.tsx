import * as ipc from "../ipc";
import { groupByDay } from "../helpers";
import { Icon } from "../components/Icon";
import { Transcript } from "../components/Transcript";
import { errorText, type AppState } from "../state";

export function History({ state }: { state: AppState }) {
  const {
    query,
    setQuery,
    history,
    confirmClear,
    setConfirmClear,
    refreshHistory,
    setNotice,
    languages,
    copy,
    insert,
  } = state;
  const count = history.length;
  const summary = query
    ? `${count} ${count === 1 ? "match" : "matches"}`
    : `${count} ${count === 1 ? "transcript" : "transcripts"}`;
  return (
    <div className="history">
      <div className="history-head">
        <div className="title-block">
          <h1>History</h1>
          {(count > 0 || query) && <p className="count">{summary}</p>}
        </div>
        <label className="search">
          <Icon name="search" size={17} />
          <span className="visually-hidden">Search transcripts</span>
          <input
            type="search"
            placeholder="Search what you said"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {count > 0 && !query && (
          <button
            type="button"
            className="button quiet"
            onClick={() => setConfirmClear(true)}
          >
            Clear all
          </button>
        )}
      </div>
      {confirmClear && (
        <div className="confirm" role="alert">
          <p>Delete every transcript? This can’t be undone.</p>
          <button
            type="button"
            className="button"
            onClick={() => setConfirmClear(false)}
          >
            Keep them
          </button>
          <button
            type="button"
            className="button danger"
            onClick={() =>
              void ipc
                .clearHistory()
                .then(() => {
                  setConfirmClear(false);
                  return refreshHistory();
                })
                .catch((e) => setNotice(errorText(e)))
            }
          >
            Delete all
          </button>
        </div>
      )}
      {count === 0 ? (
        <div className="empty empty-history">
          {query ? (
            <>
              <p className="empty-title">Nothing matches “{query}”</p>
              <p>Try fewer words, or another language.</p>
              <button
                type="button"
                className="button"
                onClick={() => setQuery("")}
              >
                Clear search
              </button>
            </>
          ) : (
            <>
              <p className="empty-title">No transcripts yet</p>
              <p>Everything you dictate is kept here, on this computer only.</p>
            </>
          )}
        </div>
      ) : (
        groupByDay(history).map((group) => (
          <section className="day" key={group.label} aria-label={group.label}>
            <h2 className="day-label">{group.label}</h2>
            <ol className="entries">
              {group.entries.map((entry) => (
                <Transcript
                  key={entry.id}
                  entry={entry}
                  languages={languages}
                  query={query}
                  timeInGutter
                  onCopy={copy}
                  onInsert={insert}
                  onDelete={() =>
                    void ipc
                      .deleteHistory(entry.id)
                      .then(refreshHistory)
                      .catch((e) => setNotice(errorText(e)))
                  }
                />
              ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}
