import { useState } from "react";
import * as ipc from "../ipc";
import {
  groupByDay,
  RETENTION_DAYS,
  retentionLabel,
  shortensRetention,
} from "../helpers";
import { Icon } from "../components/Icon";
import { Select } from "../components/Controls";
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
    settings,
    update,
  } = state;
  const retention = settings?.historyRetentionDays ?? 0;
  /** A shorter retention waiting for the user to confirm the deletion. */
  const [pendingRetention, setPendingRetention] = useState<number | null>(null);
  async function applyRetention(days: number) {
    setPendingRetention(null);
    await update("historyRetentionDays", days);
    await refreshHistory();
  }
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
        <div className="history-actions">
          <label className="retention" htmlFor="history-retention">
            Keep
            <Select
              id="history-retention"
              value={String(pendingRetention ?? retention)}
              onChange={(value) => {
                const days = Number(value);
                if (shortensRetention(retention, days)) {
                  setConfirmClear(false);
                  setPendingRetention(days);
                } else void applyRetention(days);
              }}
            >
              {RETENTION_DAYS.map((days) => (
                <option key={days} value={days}>
                  {retentionLabel(days)}
                </option>
              ))}
            </Select>
          </label>
          {count > 0 && !query && (
            <button
              type="button"
              className="button quiet"
              onClick={() => {
                setPendingRetention(null);
                setConfirmClear(true);
              }}
            >
              Clear all
            </button>
          )}
        </div>
        {pendingRetention !== null && (
          <div className="confirm" role="alert">
            <p>
              Delete transcripts older than {pendingRetention} days? From now
              on, older ones are deleted every day.
            </p>
            <button
              type="button"
              className="button"
              onClick={() => setPendingRetention(null)}
            >
              Keep them
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => void applyRetention(pendingRetention)}
            >
              Delete older
            </button>
          </div>
        )}
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
      </div>
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
              <p>
                {retention
                  ? `Everything you dictate is kept here for ${retention} days, on this computer only.`
                  : "Everything you dictate is kept here, on this computer only."}
              </p>
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
