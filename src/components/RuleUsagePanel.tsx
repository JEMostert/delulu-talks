import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { CustomWord } from "../types";
import { Modal } from "./ui";

export function RuleUsagePanel({ words }: { words: CustomWord[] }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const resetting = useRef(false);
  const refreshPending = useRef(false);
  const desktop = Boolean(window.delulu);

  const refresh = useCallback(async () => {
    if (resetting.current) {
      refreshPending.current = true;
      return;
    }
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await bridge.getRuleUsage();
      if (!mounted.current || request !== generation.current) return;
      if (result.error) setError(result.error);
      else {
        setCounts(result.counts);
        setError(null);
      }
    } catch (reason) {
      if (!mounted.current || request !== generation.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Usage counts could not be loaded.",
      );
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bridge.onTranscript(() => void refresh());
    return () => {
      mounted.current = false;
      generation.current++;
      unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [words, refresh]);

  const closeReset = () => {
    if (!resetting.current) setConfirmReset(false);
  };
  const reset = async () => {
    if (resetting.current) return;
    resetting.current = true;
    const request = ++generation.current;
    setResetBusy(true);
    setLoading(false);
    setResetError(null);
    try {
      const result = await bridge.resetRuleUsage();
      if (!mounted.current || request !== generation.current) return;
      if (result.error) {
        setResetError(result.error);
        setError(result.error);
      } else {
        setCounts(result.counts);
        setError(null);
        setConfirmReset(false);
      }
    } catch (reason) {
      if (!mounted.current || request !== generation.current) return;
      setResetError(
        reason instanceof Error
          ? reason.message
          : "Usage counts could not be reset.",
      );
    } finally {
      resetting.current = false;
      if (mounted.current) {
        setResetBusy(false);
        if (refreshPending.current) {
          refreshPending.current = false;
          void refresh();
        }
      }
    }
  };

  return (
    <section className="rounded-panel border border-line bg-surface p-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2>Rule usage</h2>
        <div className="flex flex-wrap gap-2">
          <button
            className="secondary-button"
            disabled={loading || resetBusy || !desktop}
            onClick={() => void refresh()}
          >
            {loading ? "Refreshing…" : "Refresh counts"}
          </button>
          <button
            className="secondary-button"
            disabled={resetBusy || !desktop}
            onClick={() => {
              setResetError(null);
              setConfirmReset(true);
            }}
          >
            Reset all counts
          </button>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-muted">
        Counts track source phrase matches in new dictations and audio imports,
        including sessions with history disabled. They do not measure deliveries
        or accepted rewrites. Previews do not count. Editing a rule keeps its
        counter while its ID stays the same. Only numeric counts are stored.
      </p>
      {!desktop && (
        <p className="mt-3 text-[12px] text-muted">
          Usage counts are available in the installed desktop app. This browser
          preview cannot load or reset them.
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
          {counts !== null && " Showing the last available counts."}
        </p>
      )}
      {loading && counts !== null && (
        <p className="caption mt-3" role="status">
          Refreshing usage counts…
        </p>
      )}
      {counts === null ? (
        <p className="mt-3 text-[12px] text-muted" role="status">
          {loading ? "Loading usage counts…" : "No usage counts loaded."}
        </p>
      ) : words.length ? (
        <div className="mt-3 max-h-[320px] overflow-y-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-2 font-normal" scope="col">
                  Current rule
                </th>
                <th className="py-2 text-right font-normal" scope="col">
                  Matches
                </th>
              </tr>
            </thead>
            <tbody>
              {words.map((word) => (
                <tr
                  className="border-b border-line last:border-0"
                  key={word.id}
                >
                  <th
                    className="py-2 pr-3 font-normal wrap-anywhere"
                    scope="row"
                  >
                    {word.term}
                  </th>
                  <td className="py-2 text-right tabular-nums">
                    {(Object.prototype.hasOwnProperty.call(counts, word.id)
                      ? counts[word.id]
                      : 0
                    ).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-muted">
          Add a rule to see its count.
        </p>
      )}
      {confirmReset && (
        <Modal
          title="Reset all rule usage counts?"
          busy={resetBusy}
          onClose={closeReset}
          footer={
            <>
              <button
                className="secondary-button"
                disabled={resetBusy}
                onClick={closeReset}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={resetBusy}
                onClick={() => void reset()}
              >
                {resetBusy ? "Resetting…" : "Reset all counts permanently"}
              </button>
            </>
          }
        >
          <p>
            Permanently clear all stored usage counts, including counters for
            deleted rules. This also replaces an unreadable counter file with
            empty counts. This cannot be undone.
          </p>
          <p>Rules, settings, and transcripts are not deleted.</p>
          {resetError && (
            <p className="field-error" role="alert">
              {resetError}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
