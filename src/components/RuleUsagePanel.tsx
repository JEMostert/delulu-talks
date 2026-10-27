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
    if (desktop) void refresh();
  }, [words, refresh, desktop]);

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
        <p className="text-[12px] text-muted">
          {desktop
            ? "Matches in new dictations and file transcripts. Only counts are stored."
            : "Usage counts are available in the desktop app."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className="secondary-button"
            disabled={loading || resetBusy || !desktop}
            onClick={() => void refresh()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="secondary-button"
            disabled={resetBusy || !desktop}
            onClick={() => {
              setResetError(null);
              setConfirmReset(true);
            }}
          >
            Reset
          </button>
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
          {counts !== null && " Showing the last available counts."}
        </p>
      )}
      {counts === null ? (
        <p className="mt-3 text-[12px] text-muted" role="status">
          {loading ? "Loading usage counts…" : "No counts yet."}
        </p>
      ) : words.length ? (
        <div className="mt-3 max-h-[320px] overflow-y-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-2 font-normal" scope="col">
                  Word
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
          Add a word to see its count.
        </p>
      )}
      {confirmReset && (
        <Modal
          title="Reset all usage counts?"
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
                {resetBusy ? "Resetting…" : "Reset counts"}
              </button>
            </>
          }
        >
          <p>
            This clears every count and can’t be undone. Your words, settings
            and transcripts stay.
          </p>
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
