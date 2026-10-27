import { Square, Volume2 } from "lucide-react";
import { Toggle } from "../components/ui";
import { VoiceAgentConnect } from "../components/voice/VoiceAgentConnect";
import {
  VoiceEngineSetup,
  VoiceEngineTools,
} from "../components/voice/VoiceEngineSetup";
import { VoiceSpeaker } from "../components/voice/VoiceSpeaker";
import { VoiceTalk, type SonarNeed } from "../components/voice/VoiceTalk";
import { VoiceTryIt } from "../components/voice/VoiceTryIt";
import { VoiceTuning } from "../components/voice/VoiceTuning";
import type { TalkControls } from "../hooks/useTalk";
import type { VoiceControls } from "../hooks/useVoice";
import { VOICE_ENGINE_INFO, type VoiceStatus } from "../voice";
import type { AppSettings, MicrophoneDevice } from "../types";
import "../styles/features/voice.css";

/** What Siren is saying right now; empty while it is quiet. */
function speakingLine(status: VoiceStatus): string {
  const current = status.current;
  const by = current?.agent ? ` · ${current.agent}` : "";
  const waiting = status.queued > 0 ? ` · ${status.queued} waiting` : "";
  if (current && status.phase === "speaking") return `Speaking${by}${waiting}`;
  if (status.phase === "synthesizing" || current)
    return `Getting ready${by}${waiting}`;
  return "";
}

/** Siren (spoken replies), the agent connection and Sonar (hands-free talk). */
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
  onSetupSpeech,
}: {
  settings: AppSettings;
  voice: VoiceControls;
  talk: TalkControls;
  /** Audio inputs; Sonar and dictation share the selected microphone. */
  devices: MicrophoneDevice[];
  speechReady: boolean;
  saving: boolean;
  onSave: (
    patch: Partial<AppSettings>,
    message?: string | null,
  ) => Promise<boolean>;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
  onCopy: (text: string) => void;
  /** Opens speech recognition setup, which Sonar needs. */
  onSetupSpeech?: () => void;
}) {
  const { status } = voice;
  const info = VOICE_ENGINE_INFO[s.voiceEngine];
  const save = (patch: Partial<AppSettings>) => void onSave(patch);
  const stop = () => void onAction(voice.stop);
  const setup = () => void onAction(voice.setup);
  const installing =
    status.engine === "settingUp" ||
    ["running", "cancelling"].includes(status.setupState ?? "");
  // After a crash or timeout the next sentence reloads the engine by itself;
  // only a missing engine or a failed setup keeps Siren from speaking.
  const needsSetup =
    status.engine === "missing" ||
    (status.engine === "error" && status.setupState === "failed");
  const unavailableReason = installing
    ? `Setting up ${info.name}…`
    : needsSetup
      ? `Set up ${info.name} first.`
      : "";

  // One switch for Siren and the agent connection; agents speak through Siren.
  const setSiren = async (on: boolean) => {
    if (!(await onSave({ voiceEnabled: on, voiceAgentBridge: on }))) return;
    if (on && status.engine === "missing" && !installing) setup();
    // Sonar answers through Siren; without it, it would hear you and stay silent.
    if (!on && talk.status.on) void onAction(talk.stop);
  };

  const sonarNeeds: SonarNeed[] = [];
  if (!speechReady)
    sonarNeeds.push({
      text: "Needs speech recognition",
      action: onSetupSpeech && { label: "Set up", run: onSetupSpeech },
    });
  if (!s.voiceEnabled)
    sonarNeeds.push({
      text: "Needs Siren to answer",
      action: { label: "Turn on Siren", run: () => void setSiren(true) },
    });
  else if (!s.voiceAgentBridge)
    sonarNeeds.push({
      text: "Needs the agent connection",
      action: {
        label: "Turn on",
        run: () => save({ voiceAgentBridge: true }),
      },
    });
  if (installing)
    sonarNeeds.push({ text: `Setting up the ${info.name} voice…` });
  else if (needsSetup)
    sonarNeeds.push({
      text: `Needs the ${info.name} voice`,
      action: { label: "Set up", run: setup },
    });

  return (
    <div className="content-stack siren">
      <section className="pref-list" aria-label="Siren">
        <div className="setting-row siren-main">
          <Volume2 className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Siren</strong>
            <p role="status" aria-live="polite">
              {speakingLine(status) || "Reads your agents' replies aloud"}
            </p>
          </div>
          <div className="setting-control">
            {voice.speaking && (
              <button className="tool-button" onClick={stop}>
                <Square /> Stop
              </button>
            )}
            <Toggle
              value={s.voiceEnabled}
              label="Siren"
              disabled={saving}
              onChange={() => void setSiren(!s.voiceEnabled)}
            />
          </div>
        </div>
        <VoiceEngineSetup
          status={status}
          engine={s.voiceEngine}
          saving={saving}
          onSelect={(voiceEngine) => void onSave({ voiceEngine }, null)}
          onSetup={setup}
          onCancelSetup={() => void onAction(voice.cancelSetup)}
          onLoad={() => void onAction(voice.load)}
        />
        <VoiceSpeaker
          settings={s}
          voice={voice}
          saving={saving}
          unavailableReason={unavailableReason}
          onSave={onSave}
          onAction={onAction}
        />
      </section>

      <VoiceAgentConnect
        sirenOn={s.voiceEnabled}
        enabled={s.voiceAgentBridge}
        bridge={status.bridge}
        agents={talk.status.agents}
        saving={saving}
        load={voice.agentSetup}
        installSkill={voice.installSkill}
        onEnable={() => save({ voiceAgentBridge: true })}
        onCopy={onCopy}
        onAction={onAction}
      />

      <VoiceTalk
        settings={s}
        talk={talk}
        devices={devices}
        needs={sonarNeeds}
        saving={saving}
        onSave={onSave}
        onAction={onAction}
      />

      <div className="siren-more">
        <details className="disclosure">
          <summary>Tuning</summary>
          <VoiceTuning settings={s} saving={saving} onSave={save} />
          <VoiceTryIt
            engine={s.voiceEngine}
            unavailableReason={unavailableReason}
            speaking={voice.speaking}
            onSpeak={(text) =>
              voice.speak({ text, source: "app", interrupt: true })
            }
            onStop={stop}
          />
          <VoiceEngineTools
            status={status}
            engine={s.voiceEngine}
            saving={saving}
            onLoad={() => void onAction(voice.load)}
            onUnload={() => void onAction(voice.unload)}
            onRepair={setup}
          />
        </details>
      </div>
    </div>
  );
}
