import { useEffect, useState } from "react";
import {
  Cpu,
  Gauge,
  Headphones,
  MicOff,
  Play,
  SpellCheck,
  Square,
  Upload,
  UserRound,
  Volume2,
} from "lucide-react";
import { RangeField, SettingRow, Toggle } from "../components/ui";
import { VoiceEngineSetup } from "../components/voice/VoiceEngineSetup";
import { VoiceTryIt } from "../components/voice/VoiceTryIt";
import { VoiceAgentConnect } from "../components/voice/VoiceAgentConnect";
import { VoiceRecent } from "../components/voice/VoiceRecent";
import { VoiceStep } from "../components/voice/VoiceStep";
import { VoiceTalk } from "../components/voice/VoiceTalk";
import type { TalkControls } from "../hooks/useTalk";
import type { VoiceControls } from "../hooks/useVoice";
import {
  KOKORO_VOICES,
  VOICE_ENGINE_INFO,
  type VoiceOption,
  type VoiceStatus,
} from "../voice";
import { bridge } from "../bridge";
import type { AppSettings, MicrophoneDevice } from "../types";
import "../styles/features/voice.css";

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

const VOICE_GROUPS: Array<[string, (voice: VoiceOption) => boolean]> = [
  [
    "American · female",
    (v) => v.accent === "American" && v.gender === "female",
  ],
  ["American · male", (v) => v.accent === "American" && v.gender === "male"],
  ["British · female", (v) => v.accent === "British" && v.gender === "female"],
  ["British · male", (v) => v.accent === "British" && v.gender === "male"],
];

function statusLine(status: VoiceStatus, enabled: boolean): string {
  const current = status.current;
  const waiting = status.queued > 0 ? ` · ${status.queued} waiting` : "";
  if (current && status.phase === "speaking")
    return `Speaking ${current.chunk} of ${current.chunks}${current.agent ? ` — ${current.agent}` : ""}${waiting}`;
  if (status.phase === "synthesizing" || current)
    return `Preparing speech${current?.agent ? ` — ${current.agent}` : ""}${waiting}`;
  if (status.engine === "missing") return "Set up a voice model in step 1";
  if (status.engine === "error") return status.message;
  if (!enabled) return "Off · nothing is spoken";
  return status.message;
}

export function VoicePage({
  settings: s,
  voice,
  talk,
  devices,
  speechReady,
  saving,
  onSave,
  onAction,
  onCopy,
}: {
  settings: AppSettings;
  voice: VoiceControls;
  talk: TalkControls;
  /** Audio inputs; Talk and dictation share the selected microphone. */
  devices: MicrophoneDevice[];
  speechReady: boolean;
  saving: boolean;
  onSave: (
    patch: Partial<AppSettings>,
    message?: string | null,
  ) => Promise<boolean>;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
  onCopy: (text: string) => void;
}) {
  const { status } = voice;
  const outputs = useOutputDevices();
  const engine = VOICE_ENGINE_INFO[s.voiceEngine];
  const save = (patch: Partial<AppSettings>) => void onSave(patch);
  const toggle = (key: keyof AppSettings, label: string) => (
    <Toggle
      value={!!s[key]}
      label={label}
      disabled={saving}
      onChange={() => save({ [key]: !s[key] })}
    />
  );
  // After a crash or timeout the next sentence reloads the model by itself.
  const runnable =
    status.engine === "ready" ||
    status.engine === "unloaded" ||
    (status.engine === "error" && status.setupState !== "failed");
  const unavailableReason = !s.voiceEnabled
    ? "Turn on Speak out loud in step 1 first."
    : !runnable
      ? "Set up the voice model in step 1 first."
      : "";
  const available = !unavailableReason;
  const busySpeaking = voice.speaking;
  const preview = async () => {
    const label =
      s.voiceEngine === "kokoro"
        ? (KOKORO_VOICES.find((item) => item.id === s.voiceName)?.label ??
          "Kokoro")
        : s.voiceClone
          ? "your voice clip"
          : "Chatterbox";
    await onAction(async () => {
      const result = await voice.speak({
        text:
          s.voiceEngine === "kokoro"
            ? `Hi, I'm ${label}. This is how I sound.`
            : `Hi, this is ${label}. [chuckle] This is how I sound.`,
        source: "app",
        interrupt: true,
      });
      if (result.outcome === "failed")
        throw new Error(result.error ?? "The preview could not be spoken.");
    });
  };
  const chooseClip = () =>
    void onAction(async () => {
      const next = await voice.chooseReference();
      // Sync the local copy; the desktop has already saved it.
      if (next)
        await onSave({ voiceClone: next.voiceClone }, "Voice clip saved");
    });
  const removeClip = () =>
    void onAction(async () => {
      const next = await voice.removeReference();
      await onSave({ voiceClone: next.voiceClone }, "Using the built-in voice");
    });
  const outputListed =
    s.voiceOutputDeviceId === "default" ||
    outputs.some((device) => device.deviceId === s.voiceOutputDeviceId);

  return (
    <div className="content-stack voice-page">
      <section className="voice-hero" aria-label="Voice status">
        <div className="voice-hero-copy">
          <span className="eyebrow">Delulu Voice</span>
          <h2>Voice status</h2>
          <p className="voice-status-line" role="status" aria-live="polite">
            <span
              className={`status-dot ${
                status.engine === "error"
                  ? "error"
                  : busySpeaking
                    ? "busy"
                    : status.engine === "ready" && s.voiceEnabled
                      ? "ready"
                      : status.engine === "missing"
                        ? "warning"
                        : ""
              }`}
              aria-hidden="true"
            />
            {statusLine(status, s.voiceEnabled)}
          </p>
          {status.current && (
            <p className="caption voice-current">“{status.current.text}”</p>
          )}
        </div>
        <div className="voice-hero-actions">
          {busySpeaking && (
            <button
              className="secondary-button"
              onClick={() => void onAction(voice.stop)}
            >
              <Square /> Stop
            </button>
          )}
        </div>
      </section>

      <VoiceTalk
        settings={s}
        talk={talk}
        devices={devices}
        speechReady={speechReady}
        saving={saving}
        onSave={onSave}
        onAction={onAction}
      />

      <VoiceStep
        number={1}
        title="Turn on speech"
        description="Switch on Speak out loud, then pick a voice model and set it up once."
        done={s.voiceEnabled && runnable}
      >
        <div className="pref-list">
          <SettingRow
            icon={Volume2}
            title="Speak out loud"
            description="Delulu reads text aloud with a local model. Nothing leaves your machine."
          >
            {toggle("voiceEnabled", "Speak out loud")}
          </SettingRow>
        </div>
        <VoiceEngineSetup
          status={status}
          settings={s}
          saving={saving}
          onSelect={(voiceEngine) => void onSave({ voiceEngine }, null)}
          onSetup={() => void onAction(voice.setup)}
          onCancelSetup={() => void onAction(voice.cancelSetup)}
          onLoad={() => void onAction(voice.load)}
          onUnload={() => void onAction(voice.unload)}
        />
      </VoiceStep>

      <VoiceStep
        number={2}
        title="Choose how it sounds"
        description="Pick a speaker, adjust speed and volume, then try some text."
      >
        <section className="pref-group">
          <h3>Voice</h3>
          <div className="pref-list">
            {s.voiceEngine === "kokoro" ? (
              <SettingRow
                icon={UserRound}
                title="Speaker"
                description="Kokoro's English voices."
              >
                <select
                  aria-label="Kokoro voice"
                  value={s.voiceName}
                  disabled={saving}
                  onChange={(event) => save({ voiceName: event.target.value })}
                >
                  {VOICE_GROUPS.map(([label, matches]) => (
                    <optgroup key={label} label={label}>
                      {KOKORO_VOICES.filter(matches).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  className="secondary-button"
                  disabled={!available || saving}
                  title={available ? "Hear this voice" : unavailableReason}
                  onClick={() => void preview()}
                >
                  <Play /> Preview
                </button>
              </SettingRow>
            ) : (
              <SettingRow
                icon={UserRound}
                title={s.voiceClone ? "Your voice clip" : "Built-in voice"}
                description={
                  s.voiceClone
                    ? `Speaking in the voice from ${s.voiceClone}.`
                    : "Chatterbox's own voice. Choose a clip to speak in another voice."
                }
                help="Use 5–20 seconds of one person speaking clearly, with no music or background voices. Only clone a voice you have permission to use."
              >
                {s.voiceClone && (
                  <button
                    className="tool-button"
                    disabled={saving}
                    onClick={removeClip}
                  >
                    Use built-in
                  </button>
                )}
                <button
                  className="secondary-button"
                  disabled={saving}
                  onClick={chooseClip}
                >
                  <Upload /> {s.voiceClone ? "Replace clip" : "Choose clip…"}
                </button>
                <button
                  className="secondary-button"
                  disabled={!available || saving}
                  title={available ? "Hear this voice" : unavailableReason}
                  onClick={() => void preview()}
                >
                  <Play /> Preview
                </button>
              </SettingRow>
            )}
          </div>
          {s.voiceEngine === "chatterbox-turbo" && (
            <p className="pref-note">
              Voice clip: 5–20 seconds of one person speaking clearly, no music.
            </p>
          )}
        </section>

        <section className="pref-group">
          <h3>Delivery</h3>
          <div className="pref-list">
            <SettingRow icon={Gauge} title="Speed">
              <RangeField
                label="Speaking speed"
                min={0.5}
                max={2}
                step={0.05}
                value={s.voiceSpeed}
                format={(value) => `${value.toFixed(2)}×`}
                disabled={saving}
                onCommit={(voiceSpeed) => save({ voiceSpeed })}
              />
            </SettingRow>
            <SettingRow icon={Volume2} title="Volume">
              <RangeField
                label="Speech volume"
                min={0}
                max={1}
                step={0.01}
                value={s.voiceVolume}
                format={(value) => `${Math.round(value * 100)}%`}
                disabled={saving}
                onCommit={(voiceVolume) => save({ voiceVolume })}
              />
            </SettingRow>
            <SettingRow icon={Headphones} title="Output">
              <select
                aria-label="Speech output device"
                value={s.voiceOutputDeviceId}
                disabled={saving}
                onChange={(event) =>
                  save({ voiceOutputDeviceId: event.target.value })
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
          </div>
        </section>

        <section className="pref-group">
          <h3>Try it</h3>
          <div className="pref-list voice-try-card">
            <VoiceTryIt
              engine={s.voiceEngine}
              available={available}
              unavailableReason={unavailableReason}
              speaking={busySpeaking}
              onSpeak={(text) =>
                voice.speak({ text, source: "app", interrupt: true })
              }
              onStop={() => void onAction(voice.stop)}
            />
          </div>
        </section>
      </VoiceStep>

      <VoiceStep
        number={3}
        title="Connect your coding agents"
        description="Let Claude Code, Codex or another agent speak to you and hear you."
        done={
          s.voiceAgentBridge && status.bridge.listening && !status.bridge.error
        }
        optional
      >
        <VoiceAgentConnect
          enabled={s.voiceAgentBridge}
          bridge={status.bridge}
          saving={saving}
          load={voice.agentSetup}
          installSkill={voice.installSkill}
          onToggle={() => save({ voiceAgentBridge: !s.voiceAgentBridge })}
          onCopy={onCopy}
          onAction={onAction}
        />
      </VoiceStep>

      <section className="pref-group">
        <h3>More options</h3>
        <div className="pref-list">
          <SettingRow
            icon={MicOff}
            title="Stop speaking when I start dictating"
            description="Talk over it to answer right away."
          >
            {toggle(
              "voiceInterruptOnDictation",
              "Stop speaking when I start dictating",
            )}
          </SettingRow>
          <SettingRow
            icon={SpellCheck}
            title="Read code and file names as words"
            description="Paths and identifiers become words; code blocks are skipped."
          >
            {toggle("voiceNormalizeText", "Read code and file names as words")}
          </SettingRow>
          <SettingRow
            icon={Cpu}
            title="Keep the voice model loaded"
            description={`Otherwise ${engine.name} unloads after ${s.modelIdleMinutes} idle minutes.`}
          >
            {toggle("voiceKeepLoaded", "Keep the voice model loaded")}
          </SettingRow>
        </div>
      </section>

      <VoiceRecent items={status.recent} />
    </div>
  );
}
