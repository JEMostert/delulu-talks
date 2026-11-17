import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import {
  groupByDay,
  RETENTION_DAYS,
  retentionLabel,
  shortensRetention,
  hotkeyKeys,
} from "../helpers";
import { countLabel, inRange, type HistoryRange } from "../historyRange";
import { errorText, HISTORY_LIMIT, type AppState } from "../state";
import { IconButton, Keys, Segmented, Select } from "./Controls";
import { Icon } from "./Icon";
import { Transcript } from "./Transcript";

const ranges: { value: HistoryRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "all", label: "All" },
];

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** The start of today, moving on at midnight and when the window comes back
 * (a timer can sleep through midnight while the computer is suspended). */
function useToday() {
  const [today, setToday] = useState(() => startOfDay(Date.now()));
  useEffect(() => {
    const check = () => setToday(startOfDay(Date.now()));
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const timer = setTimeout(check, tomorrow.getTime() - Date.now() + 500);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [today]);
  return today;
}

/** Every transcript: search, range, day groups, one line each. */
export function HistoryPanel({ state }: { state: AppState }) {
  const {
    status,
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
  const [range, setRange] = useState<HistoryRange>("all");
  const retention = settings?.historyRetentionDays ?? 0;
  /** A shorter retention waiting for the user to confirm the deletion. */
  const [pendingRetention, setPendingRetention] = useState<number | null>(null);
  const today = useToday();
  const shown = useMemo(
    () => inRange(history, range, today),
    [history, range, today],
  );
  const groups = useMemo(() => groupByDay(shown, today), [shown, today]);
  async function applyRetention(days: number) {
    setPendingRetention(null);
    await update("historyRetentionDays", days);
    await refreshHistory();
  }
  const count = countLabel(shown.length, history.length, HISTORY_LIMIT);
  const countTip = query
    ? `${count} ${shown.length === 1 ? "match" : "matches"}`
    : count.endsWith("+")
      ? `The newest ${HISTORY_LIMIT} transcripts. Search finds older ones.`
      : `${count} ${shown.length === 1 ? "transcript" : "transcripts"}`;
  return (
    <section className="history glass-card" aria-label="History">
      <div className="history-bar">
        <label className="search">
          <Icon name="search" size={16} />
          <span className="visually-hidden">Search transcripts</span>
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Segmented
          name="history-range"
          label="Show"
          value={range}
          onChange={setRange}
          options={ranges}
        />
        <span
          className="history-count tabular"
          data-tip={countTip}
          aria-label={countTip}
          role="status"
        >
          {count}
        </span>
        <Select
          id="history-retention"
          label="Keep transcripts for"
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
              Keep {retentionLabel(days).toLowerCase()}
            </option>
          ))}
        </Select>
        <IconButton
          icon="trash"
          label="Delete all history"
          tone="danger"
          disabled={history.length === 0 || query !== ""}
          onClick={() => {
            setPendingRetention(null);
            setConfirmClear(true);
          }}
        />
      </div>
      {pendingRetention !== null && (
        <div className="confirm" role="alert">
          <p>
            Delete transcripts older than {pendingRetention} days? From now on,
            older ones are deleted every day.
          </p>
          <button
            type="button"
            className="button small"
            onClick={() => setPendingRetention(null)}
          >
            Keep them
          </button>
          <button
            type="button"
            className="button small danger"
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
            className="button small"
            onClick={() => setConfirmClear(false)}
          >
            Keep them
          </button>
          <button
            type="button"
            className="button small danger"
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
      <div className="history-list">
        {shown.length === 0 ? (
          <div className="empty">
            {query ? (
              <>
                <p className="empty-title">Nothing matches “{query}”</p>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </button>
              </>
            ) : history.length > 0 ? (
              <>
                <p className="empty-title">
                  Nothing {range === "today" ? "today" : "this week"}
                </p>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setRange("all")}
                >
                  Show all
                </button>
              </>
            ) : (
              <>
                <p className="empty-title">Nothing said yet</p>
                <p>
                  {hotkeyKeys(status?.hotkey.trigger).length ? (
                    <>
                      Hold <Keys trigger={status?.hotkey.trigger} /> in any app
                      and talk
                    </>
                  ) : (
                    "Set a hotkey to start talking"
                  )}
                </p>
              </>
            )}
          </div>
        ) : (
          groups.map((group) => (
            <section className="day" key={group.label} aria-label={group.label}>
              <h2 className="day-label">{group.label}</h2>
              <ol>
                {group.entries.map((entry) => (
                  <Transcript
                    key={entry.id}
                    entry={entry}
                    languages={languages}
                    query={query}
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
    </section>
  );
}
