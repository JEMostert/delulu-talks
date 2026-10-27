import * as ipc from "../ipc";
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
  return (
    <>
      <div className="page-heading">
        <h1>History</h1>
        <p>Find and manage your past transcripts.</p>
      </div>
      <div className="history-tools">
        <label className="search">
          <span>Search transcripts</span>
          <input
            type="search"
            placeholder="Search transcripts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {history.length > 0 && (
          <button onClick={() => setConfirmClear(true)}>Clear history</button>
        )}
      </div>
      {confirmClear && (
        <div className="confirm" role="alert">
          <p>Delete all transcripts? This cannot be undone.</p>
          <button onClick={() => setConfirmClear(false)}>Cancel</button>
          <button
            className="danger"
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
      {history.length === 0 ? (
        <p className="empty">
          {query ? "No transcripts match your search." : "No transcripts yet."}
        </p>
      ) : (
        history.map((entry) => (
          <Transcript
            key={entry.id}
            entry={entry}
            languages={languages}
            onCopy={copy}
            onInsert={insert}
            onDelete={() =>
              void ipc
                .deleteHistory(entry.id)
                .then(refreshHistory)
                .catch((e) => setNotice(errorText(e)))
            }
          />
        ))
      )}
    </>
  );
}
