import { useState } from "react";
import { Compass, Download, Mic, Radar } from "lucide-react";
import { Toggle } from "../ui";
import type { TalkControls } from "../../hooks/useTalk";
import { microphoneOptions } from "../../microphoneSelection";
import {
  helperLine,
  helperTone,
  normalizeHelperMode,
  talkLine,
  type VoiceHelperMode,
} from "../../talk";
import type { AppSettings, MicrophoneDevice } from "../../types";
import { TalkLevelMeter } from "./TalkLevelMeter";
import { TalkTurns } from "./TalkTurns";
import "../../styles/features/talk.css";

/** Something Sonar needs before it can start, and the button that fixes it. */
export type SonarNeed = {
  text: string;
  /** Without an action the need resolves by itself, e.g. a running setup. */
  action?: { label: string; run: () => void };
};

/** Sonar: one switch to talk with your agents, what it still needs and Pilot. */
export function VoiceTalk({
  settings: s,
  talk,
  devices,
  needs,
  saving,
  onSave,
  onAction,
}: {
  settings: AppSettings;
  talk: TalkControls;
  /** Audio inputs, to name the shared dictation microphone. */
  devices: MicrophoneDevice[];
  /** Unmet prerequisites; the switch stays off until there are none. */
  needs: SonarNeed[];
  saving: boolean;
  onSave: (
    patch: Partial<AppSettings>,
    message?: string | null,
  ) => Promise<boolean>;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const { status } = talk;
  const mode = normalizeHelperMode(s.voiceCoordinatorMode);
  // A start can take a while (loading or downloading Pilot); Stop stays available.
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const on = status.on || starting;
  const start = async (download: boolean) => {
    if (starting) return;
    setStarting(true);
    try {
      await onAction(() => talk.start(download ? { download } : undefined));
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    if (stopping) return;
    // A pending start (e.g. a download) no longer holds the switch on.
    setStarting(false);
    setStopping(true);
    try {
      await onAction(talk.stop);
    } finally {
      setStopping(false);
    }
  };
  const choosePilot = async (next: VoiceHelperMode) => {
    if (await onSave({ voiceCoordinatorMode: next }, null))
      await talk.refresh().catch(() => undefined);
  };
  const pilotBusy =
    status.phase === "downloading" || status.phase === "loading";
  const offerDownload = status.needsDownload && mode === "lightweight";
  const selected = s.inputDeviceId || "default";
  const microphone =
    microphoneOptions(s, devices).find((option) => option.value === selected)
      ?.label ?? "System default";

  return (
    <section className="sonar" aria-label="Sonar">
      <div className="pref-list">
        <div className="setting-row">
          <Radar className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Sonar</strong>
            <p className="sonar-line" role="status" aria-live="polite">
              {status.on && (
                <span
                  className={`talk-dot ${status.phase === "hearing" ? "speaking" : ""}`}
                  aria-hidden="true"
                />
              )}
              {talkLine(status)}
            </p>
            <p className="sonar-mic">
              <Mic aria-hidden="true" />
              <span className="sr-only">Microphone: </span>
              <span className="sonar-mic-name">{microphone}</span>
              {status.on && <TalkLevelMeter />}
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              value={on}
              label="Sonar"
              disabled={stopping || (!on && needs.length > 0)}
              onChange={() => void (on ? stop() : start(false))}
            />
          </div>
        </div>
        {!on &&
          needs.map((need) => (
            <div key={need.text} className="setting-row sonar-need">
              <span className="status-dot warning" aria-hidden="true" />
              <div className="setting-copy">{need.text}</div>
              {need.action && (
                <div className="setting-control">
                  <button
                    className="secondary-button compact"
                    disabled={saving}
                    onClick={need.action.run}
                  >
                    {need.action.label}
                  </button>
                </div>
              )}
            </div>
          ))}
        <div className="setting-row sonar-picker">
          <Compass className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Pilot</strong>
            <p className="sonar-line">
              <span
                className={`status-dot ${helperTone(status, mode)}`}
                aria-hidden="true"
              />
              {helperLine(status, mode)}
            </p>
          </div>
          <div className="setting-control">
            {offerDownload && (
              <button
                className="primary-button compact"
                disabled={starting || pilotBusy || needs.length > 0}
                onClick={() => void start(true)}
              >
                <Download />
                {status.downloadSize
                  ? `Download ${status.downloadSize}`
                  : "Download"}
              </button>
            )}
            <select
              aria-label="Pilot"
              value={mode}
              disabled={saving || pilotBusy}
              onChange={(event) =>
                void choosePilot(event.target.value as VoiceHelperMode)
              }
            >
              <option value="off">Off</option>
              <option value="lightweight">Lightweight · 0.8B</option>
            </select>
          </div>
        </div>
      </div>
      <TalkTurns turns={status.turns} />
    </section>
  );
}
