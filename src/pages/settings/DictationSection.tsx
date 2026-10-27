import { useEffect, useState } from "react";
import {
  AudioWaveform,
  Check,
  Keyboard,
  Languages,
  Mic,
  SpellCheck,
} from "lucide-react";
import { AUTO_LANGUAGE } from "../../data";
import {
  speechLanguageCapability,
  speechLanguageHelp,
} from "../../speechCapabilities";
import { NumberField, SettingRow } from "../../components/ui";
import { MicrophoneNotice } from "../../components/MicrophoneNotice";
import { SpeechSetup } from "../../components/models/SpeechSetup";
import type {
  AppSettings,
  DictationStatus,
  MicrophoneDevice,
  PlatformCapabilities,
  ShortcutStatus,
} from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

/** Dictation: the speech model first, then what you speak into and how. */
export function DictationSection({
  status,
  devices,
  capabilities,
  shortcutStatus,
  onConfigureShortcut,
  onSetup,
  onCancelSetup,
  onDone,
  ...section
}: SectionProps & {
  status: DictationStatus;
  devices: MicrophoneDevice[];
  capabilities: PlatformCapabilities | null;
  shortcutStatus: ShortcutStatus;
  onConfigureShortcut: () => void;
  onSetup: () => void;
  onCancelSetup?: () => void;
  /** Shown while first-run setup is open; closes it. */
  onDone?: () => void;
}) {
  const { settings: s, saving, busy, save } = section;
  const [shortcut, setShortcut] = useState(s.shortcut);
  useEffect(() => setShortcut(s.shortcut), [s.shortcut]);
  const language = speechLanguageCapability(s.speechEngine, s.model);
  const mac = capabilities?.platform === "darwin";
  const portal = shortcutStatus.method === "portal";
  const accelerator = portal
    ? shortcutStatus.accelerator.replace("Super", "Meta")
    : s.shortcut;

  return (
    <>
      <SpeechSetup
        largeSpeechAvailable={!!capabilities?.largeSpeechAvailable}
        status={status}
        settings={s}
        busy={busy || saving}
        onSetup={onSetup}
        onCancelSetup={onCancelSetup}
        onUpdateSettings={save}
      />
      {onDone && status.engine === "ready" && status.warmup === "complete" && (
        <div className="setup-finished">
          <span className="flex items-center gap-2">
            <Check className="text-success" />
            Ready. Press {accelerator} in any app to dictate.
          </span>
          <button className="primary-button" onClick={onDone}>
            Done
          </button>
        </div>
      )}

      <Group title="Input">
        <SettingRow icon={Mic} title="Microphone">
          <div className="flex flex-col items-end gap-1">
            <select
              aria-label="Microphone"
              value={s.inputDeviceId}
              disabled={saving || busy}
              onChange={(e) =>
                save({
                  inputDeviceId: e.target.value,
                  inputDeviceLabel:
                    devices.find((d) => d.deviceId === e.target.value)?.label ??
                    "Microphone",
                })
              }
            >
              {!devices.some((d) => d.deviceId === s.inputDeviceId) && (
                <option value={s.inputDeviceId}>
                  {s.inputDeviceLabel} (not listed)
                </option>
              )}
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
            <MicrophoneNotice settings={s} devices={devices} />
          </div>
        </SettingRow>
        <SettingRow
          icon={Languages}
          title="Language"
          help={speechLanguageHelp(s.speechEngine, s.language)}
        >
          <select
            aria-label="Language"
            value={s.language}
            disabled={saving || busy || !language.canSelectLanguage}
            onChange={(e) => save({ language: e.target.value })}
          >
            {language.canRequestAutomaticLanguage && (
              <option value={AUTO_LANGUAGE}>Automatic detection</option>
            )}
            {language.languages.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </SettingRow>
        {s.speechEngine === "large" && !mac && (
          <SettingRow
            icon={SpellCheck}
            title="Word hints"
            description="Large listens for the words on the Words page."
          >
            <SettingToggle
              {...section}
              name="vocabularyHints"
              label="Word hints"
            />
          </SettingRow>
        )}
      </Group>

      <Group title="Shortcut">
        <SettingRow
          icon={Keyboard}
          title="Dictation shortcut"
          description={
            shortcutStatus.registered
              ? undefined
              : shortcutStatus.message ||
                "Not registered. Choose another combination."
          }
        >
          <div className="inline-control">
            {portal ? (
              <>
                <kbd>{accelerator}</kbd>
                <button
                  className="secondary-button compact"
                  onClick={onConfigureShortcut}
                >
                  Change
                </button>
              </>
            ) : (
              <>
                <input
                  className="w-44"
                  aria-label="Dictation shortcut"
                  value={shortcut}
                  onChange={(e) => setShortcut(e.target.value)}
                />
                <button
                  className="secondary-button compact"
                  disabled={saving || shortcut === s.shortcut}
                  onClick={() => save({ shortcut })}
                >
                  Save
                </button>
              </>
            )}
          </div>
        </SettingRow>
        <SettingRow
          title="Gesture"
          description={
            portal ? undefined : "This desktop only reports key presses."
          }
        >
          <select
            aria-label="Recording gesture"
            value={portal ? s.shortcutMode : "toggle"}
            disabled={saving || !portal}
            onChange={(e) =>
              save({
                shortcutMode: e.target.value as AppSettings["shortcutMode"],
              })
            }
          >
            <option value="hold">Hold to talk</option>
            <option value="toggle">Press to toggle</option>
          </select>
        </SettingRow>
      </Group>

      <Group title="While you speak">
        <SettingRow icon={AudioWaveform} title="Stop after silence">
          <SettingToggle
            {...section}
            name="trailingSilenceStopEnabled"
            label="Stop after silence"
            disabled={busy}
          />
        </SettingRow>
        {s.trailingSilenceStopEnabled && (
          <>
            <SettingRow title="Silence length (seconds)">
              <NumberField
                label="Silence duration in seconds"
                min={2}
                max={30}
                value={s.trailingSilenceSeconds}
                disabled={busy}
                onCommit={(trailingSilenceSeconds) =>
                  save({ trailingSilenceSeconds })
                }
              />
            </SettingRow>
            <SettingRow
              title="Silence level (dB)"
              description="Anything quieter counts as silence."
            >
              <NumberField
                label="Silence threshold in dB"
                min={-60}
                max={-20}
                value={s.trailingSilenceThresholdDb}
                disabled={busy}
                onCommit={(trailingSilenceThresholdDb) =>
                  save({ trailingSilenceThresholdDb })
                }
              />
            </SettingRow>
          </>
        )}
      </Group>

      <Group title="Formatting">
        <SettingRow
          title="Punctuation"
          description="Spoken: say “insert comma”. English and Dutch."
        >
          <select
            aria-label="Dictation formatting"
            value={s.dictationFormatting ?? "preserve"}
            disabled={saving || busy}
            onChange={(e) =>
              save({
                dictationFormatting: e.target
                  .value as AppSettings["dictationFormatting"],
              })
            }
          >
            <option value="preserve">Recognized</option>
            <option value="spoken">Spoken</option>
          </select>
        </SettingRow>
        <SettingRow
          title="Line commands"
          description="Say “command new line” or “commando nieuwe alinea”."
        >
          <SettingToggle
            {...section}
            name="spokenFormattingCommands"
            label="Interpret spoken line commands"
            disabled={busy}
          />
        </SettingRow>
      </Group>
    </>
  );
}
