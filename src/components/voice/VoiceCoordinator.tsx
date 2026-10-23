import { useEffect, useRef, useState } from "react";
import { Cpu, Download } from "lucide-react";
import { bridge } from "../../bridge";
import type {
  CoordinatorStatus,
  VoiceCoordinatorMode,
} from "../../coordinator";
import type { AppSettings } from "../../types";
import { SettingRow } from "../ui";
import { VoiceStep } from "./VoiceStep";

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** Choosing a model only saves it; downloading and loading are explicit. */
export function VoiceCoordinator({
  mode,
  listening,
  saving,
  onSave,
}: {
  mode: VoiceCoordinatorMode;
  /** The microphone from step 4 is open. */
  listening: boolean;
  saving: boolean;
  onSave: (
    patch: Partial<AppSettings>,
    message?: string | null,
  ) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<CoordinatorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const locked = useRef(false);
  const refresh = async () => {
    const current = ++revision.current;
    try {
      const next = await bridge.getCoordinatorStatus();
      if (mounted.current && current === revision.current) {
        setStatus(next);
        setError(null);
      }
    } catch (reason) {
      if (mounted.current && current === revision.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  useEffect(() => {
    mounted.current = true;
    const remove = bridge.onCoordinatorStatus((next) => {
      ++revision.current;
      if (mounted.current) {
        setStatus(next);
        setError(null);
      }
    });
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      ++revision.current;
      remove();
      window.removeEventListener("focus", onFocus);
    };
  }, [mode]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(label);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const matching = status?.mode === mode;
  const loading = status?.phase === "loading";
  const failed = matching && status?.phase === "failed";
  const ready = matching && status?.phase === "ready";
  const idle = !saving && !busy && !loading && matching;

  const agents = status
    ? status.registeredAgents === 0
      ? "No agent connected"
      : plural(status.registeredAgents, "agent") +
        (status.queuedTasks ? ` · ${status.queuedTasks} queued` : "")
    : "";
  const [label, detail] = busy
    ? [busy, ""]
    : !status
      ? [error ? "Status unavailable" : "Checking…", ""]
      : !matching
        ? ["Switching…", ""]
        : loading
          ? ["Setting up…", ""]
          : failed
            ? ["Couldn't start", status.message]
            : ready
              ? [
                  "Ready",
                  listening ? agents : "Turn on the microphone in step 4",
                ]
              : ["Not loaded", ""];

  return (
    <VoiceStep
      number={5}
      title="Voice helper"
      optional
      description="A small local model hears you and hands your tasks to your agent, word for word."
      done={ready}
    >
      <div className="pref-list voice-coordinator">
        <SettingRow icon={Cpu} title="Helper">
          <select
            aria-label="Voice helper"
            value={mode}
            disabled={saving || !!busy || loading}
            onChange={(event) => {
              const next = event.target.value as VoiceCoordinatorMode;
              void run("Saving…", () =>
                onSave({ voiceCoordinatorMode: next }, null),
              );
            }}
          >
            <option value="off">Off</option>
            <option value="lightweight">Lightweight · 0.8B</option>
            <option value="conversational">Conversational · 2B</option>
          </select>
        </SettingRow>
        {mode !== "off" && (
          <div
            className="voice-coordinator-bar"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className={`status-dot ${error || failed ? "error" : loading || busy ? "busy" : ready ? "ready" : ""}`}
            />
            <p>
              <strong>{label}</strong>
              {detail && <span>{detail}</span>}
            </p>
            {idle && !ready && (
              <>
                <button
                  className="tool-button"
                  title="Download and install the helper's files"
                  onClick={() =>
                    void run("Downloading…", bridge.setupCoordinator)
                  }
                >
                  <Download /> Download
                </button>
                <button
                  className="secondary-button"
                  onClick={() => void run("Loading…", bridge.loadCoordinator)}
                >
                  Load
                </button>
              </>
            )}
            {idle && ready && (
              <button
                className="tool-button"
                onClick={() => void run("Unloading…", bridge.unloadCoordinator)}
              >
                Unload
              </button>
            )}
          </div>
        )}
        {error && error !== status?.message && (
          <p role="alert" className="voice-coordinator-error">
            {error}
          </p>
        )}
      </div>
    </VoiceStep>
  );
}
