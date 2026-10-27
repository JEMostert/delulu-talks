import { Square, Volume2 } from "lucide-react";
import { Toggle } from "../components/ui";
import {
  bridgeLine,
  VoiceAgentConnect,
} from "../components/voice/VoiceAgentConnect";
import { VoiceEngineSetup } from "../components/voice/VoiceEngineSetup";
import { VoiceSpeaker } from "../components/voice/VoiceSpeaker";
import { VoiceTalk } from "../components/voice/VoiceTalk";
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

/** Siren (spoken replies) and Sonar (hands-free talk with agents). */
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
}) {
  const { status } = voice;
  const save = (patch: Partial<AppSettings>) => void onSave(patch);
  const stop = () => void onAction(voice.stop);
  // After a crash or timeout the next sentence reloads the engine by itself.
  const runnable =
    status.engine === "ready" ||
    status.engine === "unloaded" ||
    (status.engine === "error" && status.setupState !== "failed");
  const unavailableReason = !s.voiceEnabled
    ? "Turn on Speak replies aloud first."
    : !runnable
      ? `Set up ${VOICE_ENGINE_INFO[s.voiceEngine].name} first.`
      : "";
  const bridge = status.bridge;

  return (
    <div className="content-stack siren">
      <div className="pref-list">
        <div className="setting-row siren-main">
          <Volume2 className="setting-icon" aria-hidden="true" />
          <div className="setting-copy">
            <strong>Speak replies aloud</strong>
            <p role="status" aria-live="polite">
              {speakingLine(status)}
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
              label="Speak replies aloud"
              disabled={saving}
              onChange={() => save({ voiceEnabled: !s.voiceEnabled })}
            />
          </div>
        </div>
        <VoiceEngineSetup
          status={status}
          engine={s.voiceEngine}
          saving={saving}
          onSelect={(voiceEngine) => void onSave({ voiceEngine }, null)}
          onSetup={() => void onAction(voice.setup)}
          onCancelSetup={() => void onAction(voice.cancelSetup)}
          onLoad={() => void onAction(voice.load)}
          onUnload={() => void onAction(voice.unload)}
        />
        <VoiceSpeaker
          settings={s}
          voice={voice}
          saving={saving}
          unavailableReason={unavailableReason}
          onSave={onSave}
          onAction={onAction}
        />
      </div>

      <VoiceTalk
        settings={s}
        talk={talk}
        devices={devices}
        speechReady={speechReady}
        saving={saving}
        onSave={onSave}
        onAction={onAction}
      />

      <VoiceTryIt
        engine={s.voiceEngine}
        unavailableReason={unavailableReason}
        speaking={voice.speaking}
        onSpeak={(text) =>
          voice.speak({ text, source: "app", interrupt: true })
        }
        onStop={stop}
      />

      <div className="siren-more">
        <details className="disclosure">
          <summary>
            Connect agents
            {s.voiceAgentBridge && (
              <span className="siren-summary-state">
                <span
                  className={`status-dot ${bridge.error ? "error" : bridge.listening ? "ready" : "busy"}`}
                  aria-hidden="true"
                />
                {bridgeLine(bridge)}
              </span>
            )}
          </summary>
          <VoiceAgentConnect
            enabled={s.voiceAgentBridge}
            bridge={bridge}
            saving={saving}
            load={voice.agentSetup}
            installSkill={voice.installSkill}
            onToggle={() => save({ voiceAgentBridge: !s.voiceAgentBridge })}
            onCopy={onCopy}
            onAction={onAction}
          />
        </details>
        <details className="disclosure">
          <summary>Tuning</summary>
          <VoiceTuning settings={s} saving={saving} onSave={save} />
        </details>
      </div>
    </div>
  );
}
