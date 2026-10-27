import { useEffect, useState } from "react";
import { Keyboard, Languages, Mic, Monitor, SpellCheck } from "lucide-react";
import { AUTO_LANGUAGE } from "../../data";
import {
  speechLanguageCapability,
  speechLanguageHelp,
} from "../../speechCapabilities";
import { SettingRow } from "../../components/ui";
import { MicrophoneNotice } from "../../components/MicrophoneNotice";
import type {
  AppSettings,
  MicrophoneDevice,
  PlatformCapabilities,
  ShortcutStatus,
} from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

const THEMES = [
  ["system", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

export function GeneralSection({
  devices,
  capabilities,
  shortcutStatus,
  onConfigureShortcut,
  ...section
}: SectionProps & {
  devices: MicrophoneDevice[];
  capabilities: PlatformCapabilities | null;
  shortcutStatus: ShortcutStatus;
  onConfigureShortcut: () => void;
}) {
  const { settings: s, saving, busy, save } = section;
  const [shortcut, setShortcut] = useState(s.shortcut);
  useEffect(() => setShortcut(s.shortcut), [s.shortcut]);
  const language = speechLanguageCapability(s.speechEngine, s.model);
  const mac = capabilities?.platform === "darwin";
  const portal = shortcutStatus.method === "portal";

  return (
    <>
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
            description="Large listens for your Lingo words."
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
                <kbd>{shortcutStatus.accelerator.replace("Super", "Meta")}</kbd>
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

      <Group title="App">
        <SettingRow icon={Monitor} title="Theme">
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map(([theme, label]) => (
              <button
                key={theme}
                aria-pressed={s.theme === theme}
                className={s.theme === theme ? "active" : ""}
                disabled={saving}
                onClick={() => save({ theme })}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow title="Launch at login">
          <SettingToggle
            {...section}
            name="launchAtLogin"
            label="Launch at login"
          />
        </SettingRow>
        {mac && (
          <SettingRow title="Menu bar only" description="Hides the Dock icon.">
            <SettingToggle
              {...section}
              name="menuBarOnly"
              label="Menu bar only"
            />
          </SettingRow>
        )}
      </Group>
    </>
  );
}
