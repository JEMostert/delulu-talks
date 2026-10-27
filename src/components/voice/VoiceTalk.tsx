import { useState } from "react";
import { Bot, Compass, Download, Mic, Radar } from "lucide-react";
import { SettingRow, Toggle } from "../ui";
import type { TalkControls } from "../../hooks/useTalk";
import { microphoneOptions } from "../../microphoneSelection";
import {
  agentsLine,
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

/** Sonar: one switch to talk with your agents, the mic it hears and Pilot. */
export function VoiceTalk({
  settings: s,
  talk,
  devices,
  speechReady,
  saving,
  onSave,
  onAction,
}: {
  settings: AppSettings;
  talk: TalkControls;
  devices: MicrophoneDevice[];
  speechReady: boolean;
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
              {talkLine(status, speechReady)}
            </p>
          </div>
          <div className="setting-control">
            <Toggle
              value={on}
              label="Sonar"
              disabled={stopping || (!on && !speechReady)}
              onChange={() => void (on ? stop() : start(false))}
            />
          </div>
        </div>
        <div className="setting-row sonar-picker">
          <Mic className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Microphone</strong>
          </div>
          <div className="setting-control">
            {status.on && <TalkLevelMeter />}
            <select
              aria-label="Microphone"
              value={s.inputDeviceId || "default"}
              disabled={saving}
              onChange={(event) =>
                void onSave({
                  inputDeviceId: event.target.value,
                  inputDeviceLabel:
                    devices.find(
                      (device) => device.deviceId === event.target.value,
                    )?.label ?? "System default",
                })
              }
            >
              {microphoneOptions(s, devices).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
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
                disabled={starting || pilotBusy}
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
        <SettingRow
          icon={Bot}
          title="Agents"
          description={agentsLine(status.agents)}
        >
          {null}
        </SettingRow>
      </div>
      <TalkTurns turns={status.turns} />
    </section>
  );
}
