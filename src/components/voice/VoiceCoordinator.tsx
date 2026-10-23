import { useEffect, useRef, useState } from "react";
import { Cpu, Download, RefreshCw } from "lucide-react";
import { bridge } from "../../bridge";
import type {
  CoordinatorStatus,
  VoiceCoordinatorMode,
} from "../../coordinator";
import type { AppSettings } from "../../types";
import { SettingRow } from "../ui";
import { VoiceStep } from "./VoiceStep";

/** Model selection is a preference only; setup and loading are explicit actions. */
export function VoiceCoordinator({
  mode,
  saving,
  onSave,
}: {
  mode: VoiceCoordinatorMode;
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
  const disabled = saving || !!busy || loading;
  const ready = matching && status?.phase === "ready";

  return (
    <VoiceStep
      number={5}
      title="Local voice coordinator"
      optional
      description="An optional local helper for routing, turn-taking, acknowledgments and status. Your work agents do the planning."
      done={ready}
    >
      <div className="pref-list voice-coordinator">
        <SettingRow
          icon={Cpu}
          title="Coordinator"
          description="Off keeps direct listening available without loading or downloading an additional LLM."
        >
          <select
            aria-label="Voice coordinator"
            value={mode}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value as VoiceCoordinatorMode;
              void run("Saving preference…", () =>
                onSave({ voiceCoordinatorMode: next }, null),
              );
            }}
          >
            <option value="off">Off · direct (default)</option>
            <option value="lightweight">Lightweight · Qwen3.5-0.8B</option>
            <option value="conversational">Conversational · Qwen3.5-2B</option>
          </select>
        </SettingRow>
        <div className="voice-coordinator-detail">
          <p className="caption">
            Your original task wording is passed to work agents unchanged. Works
            with local CLI and MCP agents, with no cloud keys or dependency on a
            particular agent app.
          </p>
          {mode !== "off" && (
            <p className="caption">
              Selecting a helper only saves your preference. Set up / download
              explicitly to install its local files, then load it when needed.
              Loading uses existing files; it never starts a download.
            </p>
          )}
          <div
            role="status"
            aria-live="polite"
            className="voice-coordinator-status"
          >
            <p className="voice-status-line">
              <span
                aria-hidden="true"
                className={`status-dot ${error || status?.phase === "failed" ? "error" : loading || busy ? "busy" : ready ? "ready" : ""}`}
              />
              {busy ??
                (status
                  ? `${status.phase === "not-ready" ? "Not loaded" : status.phase === "failed" ? "Failed" : status.phase === "ready" ? "Ready" : status.phase === "loading" ? "Loading" : "Off"} · ${status.message}`
                  : error
                    ? "Coordinator status unavailable"
                    : "Checking coordinator status…")}
            </p>
            {status && !matching && (
              <p className="caption">
                Waiting for the coordinator to reflect your saved preference.
              </p>
            )}
            {status && status.mode !== "off" && (
              <dl className="voice-facts">
                <dt>Model</dt>
                <dd>
                  {status.model === "qwen35Small"
                    ? "Qwen3.5-0.8B"
                    : status.model === "qwen35Medium"
                      ? "Qwen3.5-2B"
                      : "None loaded"}
                </dd>
                <dt>Registered agents</dt>
                <dd>{status.registeredAgents}</dd>
                <dt>Queued tasks</dt>
                <dd>{status.queuedTasks}</dd>
                <dt>Active agent</dt>
                <dd>{status.activeAgent ?? "None"}</dd>
              </dl>
            )}
          </div>
          {error && (
            <p role="alert" className="voice-coordinator-error">
              {error}
            </p>
          )}
          <div className="voice-try-actions">
            {mode !== "off" && (
              <>
                <button
                  className="secondary-button"
                  disabled={disabled || !matching || ready}
                  onClick={() =>
                    void run(
                      "Setting up local helper…",
                      bridge.setupCoordinator,
                    )
                  }
                >
                  <Download /> Set up / download
                </button>
                <button
                  className="secondary-button"
                  disabled={disabled || !matching || ready}
                  onClick={() =>
                    void run("Loading local helper…", bridge.loadCoordinator)
                  }
                >
                  Load helper
                </button>
                <button
                  className="secondary-button"
                  disabled={disabled || !matching || !ready}
                  onClick={() =>
                    void run(
                      "Unloading local helper…",
                      bridge.unloadCoordinator,
                    )
                  }
                >
                  Unload helper
                </button>
              </>
            )}
            <button
              className="tool-button"
              disabled={!!busy}
              onClick={() => void run("Refreshing status…", refresh)}
            >
              <RefreshCw /> Refresh status
            </button>
          </div>
        </div>
      </div>
    </VoiceStep>
  );
}
