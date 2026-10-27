import { RangeField, SettingRow, Toggle } from "../../components/ui";
import type { AppSettings, PlatformCapabilities } from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

const PASTE_DELAYS = [1, 2, 3, 5, 10, 15, 20, 30];

export function OutputSection({
  capabilities,
  onAuthorizePaste,
  onTestPaste,
  onTestCaptureCue,
  ...section
}: SectionProps & {
  capabilities: PlatformCapabilities | null;
  onAuthorizePaste: () => void;
  onTestPaste: () => void;
  onTestCaptureCue: () => void;
}) {
  const { settings: s, saving, save } = section;
  const mac = capabilities?.platform === "darwin";
  const pillUnavailable = capabilities?.overlayMethod === "unavailable";

  return (
    <>
      <Group title="Delivery">
        <SettingRow title="Paste automatically">
          <SettingToggle
            {...section}
            name="autoPaste"
            label="Paste automatically"
          />
        </SettingRow>
        <SettingRow title="Copy to clipboard">
          <SettingToggle
            {...section}
            name="copyToClipboard"
            label="Copy results to clipboard"
          />
        </SettingRow>
        <SettingRow
          title="Restore clipboard"
          description="Puts your previous text back after pasting."
        >
          <SettingToggle
            {...section}
            name="restoreClipboardAfterPaste"
            label="Restore clipboard after paste"
            disabled={!s.autoPaste}
          />
        </SettingRow>
      </Group>

      <Group title="Pasting">
        <SettingRow
          title="Paste shortcut"
          description={mac ? undefined : "Terminals usually need Ctrl+Shift+V."}
        >
          <select
            aria-label="Paste shortcut"
            value={s.pasteShortcut}
            disabled={saving}
            onChange={(e) =>
              save({
                pasteShortcut: e.target.value as AppSettings["pasteShortcut"],
              })
            }
          >
            <option value="standard">
              Standard ({mac ? "Cmd+V" : "Ctrl+V"})
            </option>
            <option value="terminal">
              Terminal ({mac ? "Cmd+V" : "Ctrl+Shift+V"})
            </option>
          </select>
        </SettingRow>
        {s.autoPaste && capabilities?.wayland && (
          <SettingRow
            title="Keyboard permission"
            description="Lets your desktop paste for you."
          >
            <div className="inline-control">
              <button
                className="secondary-button compact"
                onClick={onAuthorizePaste}
              >
                Allow
              </button>
              <button className="tool-button compact" onClick={onTestPaste}>
                Test
              </button>
            </div>
          </SettingRow>
        )}
        <SettingRow
          title="Paste latest delay"
          description="Time to focus the right field."
        >
          <select
            aria-label="Paste-last delay"
            value={s.pasteLastDelaySeconds}
            disabled={saving}
            onChange={(e) =>
              save({ pasteLastDelaySeconds: Number(e.target.value) })
            }
          >
            {PASTE_DELAYS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} {seconds === 1 ? "second" : "seconds"}
              </option>
            ))}
          </select>
        </SettingRow>
      </Group>

      <Group title="Feedback">
        <SettingRow
          title="Recording pill"
          description={
            pillUnavailable ? capabilities?.overlayDetail : undefined
          }
        >
          <SettingToggle
            {...section}
            name="showOverlay"
            label="Recording pill"
            disabled={pillUnavailable}
          />
        </SettingRow>
        <SettingRow title="Recording sounds">
          <Toggle
            value={!s.captureSoundsMuted}
            label="Recording sounds"
            disabled={saving}
            onChange={() => save({ captureSoundsMuted: !s.captureSoundsMuted })}
          />
        </SettingRow>
        {!s.captureSoundsMuted && (
          <SettingRow title="Volume">
            <div className="inline-control">
              <RangeField
                label="Recording sound volume"
                min={0}
                max={1}
                step={0.01}
                value={s.captureSoundVolume}
                format={(value) => `${Math.round(value * 100)}%`}
                onCommit={(captureSoundVolume) => save({ captureSoundVolume })}
              />
              <button
                className="tool-button compact"
                disabled={saving}
                onClick={onTestCaptureCue}
              >
                Test
              </button>
            </div>
          </SettingRow>
        )}
      </Group>
    </>
  );
}
