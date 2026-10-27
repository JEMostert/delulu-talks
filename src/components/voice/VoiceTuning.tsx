import { useEffect, useState } from "react";
import {
  AudioLines,
  Cpu,
  Ear,
  Gauge,
  Headphones,
  Hourglass,
  MicOff,
  SpellCheck,
  Timer,
  Volume2,
} from "lucide-react";
import { RangeField, SettingRow, Toggle } from "../ui";
import { bridge } from "../../bridge";
import type { AppSettings, MicrophoneDevice } from "../../types";

/** Native audio outputs; the desktop lists them, the select adds the default. */
function useOutputDevices(): MicrophoneDevice[] {
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const read = () => {
      const current = ++revision;
      void bridge
        .listSpeakers()
        .then((items) => {
          if (alive && current === revision)
            setDevices(
              items.filter(
                (item) => item.deviceId && item.deviceId !== "default",
              ),
            );
        })
        .catch(() => undefined);
    };
    read();
    // There is no output change event; a returning window re-reads the list.
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return devices;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Speech delivery and Sonar's listening, behind the Tuning disclosure. */
export function VoiceTuning({
  settings: s,
  saving,
  onSave,
}: {
  settings: AppSettings;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => void;
}) {
  const outputs = useOutputDevices();
  const outputListed =
    s.voiceOutputDeviceId === "default" ||
    outputs.some((device) => device.deviceId === s.voiceOutputDeviceId);
  const toggle = (
    key:
      | "voiceInterruptOnDictation"
      | "voiceNormalizeText"
      | "voiceKeepLoaded"
      | "listenBargeIn",
    label: string,
  ) => (
    <Toggle
      value={s[key]}
      label={label}
      disabled={saving}
      onChange={() => onSave({ [key]: !s[key] })}
    />
  );

  return (
    <>
      <section className="pref-group">
        <h3>Siren</h3>
        <div className="pref-list">
          <SettingRow icon={Gauge} title="Speed">
            <RangeField
              label="Speed"
              min={0.5}
              max={2}
              step={0.05}
              value={s.voiceSpeed}
              format={(value) => `${Number(value.toFixed(2))}×`}
              disabled={saving}
              onCommit={(voiceSpeed) => onSave({ voiceSpeed })}
            />
          </SettingRow>
          <SettingRow icon={Volume2} title="Volume">
            <RangeField
              label="Volume"
              min={0}
              max={1}
              step={0.01}
              value={s.voiceVolume}
              format={percent}
              disabled={saving}
              onCommit={(voiceVolume) => onSave({ voiceVolume })}
            />
          </SettingRow>
          <SettingRow icon={Headphones} title="Output">
            <select
              aria-label="Output"
              value={s.voiceOutputDeviceId}
              disabled={saving}
              onChange={(event) =>
                onSave({ voiceOutputDeviceId: event.target.value })
              }
            >
              <option value="default">System default</option>
              {!outputListed && (
                <option value={s.voiceOutputDeviceId}>
                  Saved device (not connected)
                </option>
              )}
              {outputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow icon={MicOff} title="Stop when I start dictating">
            {toggle("voiceInterruptOnDictation", "Stop when I start dictating")}
          </SettingRow>
          <SettingRow
            icon={SpellCheck}
            title="Read code and file names as words"
          >
            {toggle("voiceNormalizeText", "Read code and file names as words")}
          </SettingRow>
          <SettingRow
            icon={Cpu}
            title="Keep the engine loaded"
            description={`Otherwise it sleeps after ${s.modelIdleMinutes} idle minutes`}
          >
            {toggle("voiceKeepLoaded", "Keep the engine loaded")}
          </SettingRow>
        </div>
      </section>
      <section className="pref-group">
        <h3>Sonar</h3>
        <div className="pref-list">
          <SettingRow icon={Ear} title="Sensitivity">
            <RangeField
              label="Sensitivity"
              min={0}
              max={1}
              step={0.05}
              value={s.listenSensitivity}
              format={percent}
              disabled={saving}
              onCommit={(listenSensitivity) => onSave({ listenSensitivity })}
            />
          </SettingRow>
          <SettingRow icon={Hourglass} title="Pause before a turn ends">
            <RangeField
              label="Pause before a turn ends"
              min={300}
              max={3000}
              step={100}
              value={s.listenSilenceMs}
              format={seconds}
              disabled={saving}
              onCommit={(listenSilenceMs) => onSave({ listenSilenceMs })}
            />
          </SettingRow>
          <SettingRow
            icon={AudioLines}
            title="Stop Delulu when I talk over it"
            help="Headphones make interruptions the most reliable."
          >
            {toggle("listenBargeIn", "Stop Delulu when I talk over it")}
          </SettingRow>
          {s.listenBargeIn && (
            <SettingRow icon={Timer} title="Interrupt after">
              <RangeField
                label="Interrupt after"
                min={100}
                max={1000}
                step={100}
                value={s.listenBargeInMs}
                format={seconds}
                disabled={saving}
                onCommit={(listenBargeInMs) => onSave({ listenBargeInMs })}
              />
            </SettingRow>
          )}
        </div>
      </section>
    </>
  );
}
