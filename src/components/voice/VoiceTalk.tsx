import { useState } from "react";
import {
  AudioLines,
  Bot,
  Cpu,
  Download,
  Ear,
  Hourglass,
  MessagesSquare,
  Mic,
  Timer,
} from "lucide-react";
import { RangeField, SettingRow, Toggle } from "../ui";
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

/** One switch to talk with your agents, the microphone it hears and the helper. */
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
  // A start can take a while (loading or downloading the helper); Stop stays available.
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
  const save = (patch: Partial<AppSettings>) => void onSave(patch);
  const chooseHelper = async (next: VoiceHelperMode) => {
    if (await onSave({ voiceCoordinatorMode: next }, null))
      await talk.refresh().catch(() => undefined);
  };
  const helperBusy =
    status.phase === "downloading" || status.phase === "loading";
  const offerDownload = status.needsDownload && mode === "lightweight";

  return (
    <section className="pref-group voice-talk" aria-labelledby="voice-talk">
      <h3 id="voice-talk">Talk to your agents</h3>
      <div className="pref-list">
        <div className="setting-row">
          <MessagesSquare className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Talk</strong>
            <p className="talk-line" role="status" aria-live="polite">
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
            {offerDownload && (
              <button
                className="primary-button compact"
                disabled={starting || helperBusy}
                onClick={() => void start(true)}
              >
                <Download />
                {status.downloadSize
                  ? `Download (${status.downloadSize})`
                  : "Download"}
              </button>
            )}
            <Toggle
              value={on}
              label="Talk"
              disabled={stopping || (!on && !speechReady)}
              onChange={() => void (on ? stop() : start(false))}
            />
          </div>
        </div>
        <div className="setting-row talk-picker-row">
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
                save({
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
        <div className="setting-row talk-picker-row">
          <Cpu className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Helper</strong>
            <p className="talk-line">
              <span
                className={`status-dot ${helperTone(status, mode)}`}
                aria-hidden="true"
              />
              {helperLine(status, mode)}
            </p>
          </div>
          <div className="setting-control">
            <select
              aria-label="Voice helper"
              value={mode}
              disabled={saving || helperBusy}
              onChange={(event) =>
                void chooseHelper(event.target.value as VoiceHelperMode)
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

      <details className="disclosure">
        <summary>Listening options</summary>
        <div className="pref-list">
          <SettingRow
            icon={Ear}
            title="Sensitivity"
            description="Low hears only clear speech; high also quiet speech."
          >
            <RangeField
              label="Listening sensitivity"
              min={0}
              max={1}
              step={0.05}
              value={s.listenSensitivity}
              format={(value) => `${Math.round(value * 100)}%`}
              disabled={saving}
              onCommit={(listenSensitivity) => save({ listenSensitivity })}
            />
          </SettingRow>
          <SettingRow
            icon={Hourglass}
            title="Pause before a turn ends"
            description="How long you stay quiet before it is sent."
          >
            <RangeField
              label="Pause before a turn ends"
              min={300}
              max={3000}
              step={100}
              value={s.listenSilenceMs}
              format={(value) => `${(value / 1000).toFixed(1)} s`}
              disabled={saving}
              onCommit={(listenSilenceMs) => save({ listenSilenceMs })}
            />
          </SettingRow>
          <SettingRow
            icon={AudioLines}
            title="Stop Delulu when I talk over it"
            description="Headphones give the most reliable interruptions."
          >
            <Toggle
              value={s.listenBargeIn}
              label="Stop Delulu when I talk over it"
              disabled={saving}
              onChange={() => save({ listenBargeIn: !s.listenBargeIn })}
            />
          </SettingRow>
          {s.listenBargeIn && (
            <SettingRow
              icon={Timer}
              title="Interrupt after"
              description="Longer ignores coughs and short noises."
            >
              <RangeField
                label="Interrupt after"
                min={100}
                max={1000}
                step={100}
                value={s.listenBargeInMs}
                format={(value) => `${(value / 1000).toFixed(1)} s`}
                disabled={saving}
                onCommit={(listenBargeInMs) => save({ listenBargeInMs })}
              />
            </SettingRow>
          )}
        </div>
      </details>
    </section>
  );
}
