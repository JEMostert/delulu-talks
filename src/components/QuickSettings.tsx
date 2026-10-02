import { AudioLines, Keyboard, Mic, Moon, Sun } from "lucide-react";
import { speechLanguageCapability } from "../speechCapabilities";
import { Toggle } from "./ui";
import type { useWorkspace } from "../hooks/useWorkspace";
import type { Page } from "../types";
import { bridge } from "../bridge";

export function QuickSettings({
  workspace: w,
  busy,
  onNavigate,
}: {
  workspace: ReturnType<typeof useWorkspace>;
  busy: boolean;
  onNavigate: (page: Page) => void;
}) {
  const s = w.settings;
  const languageCapability = speechLanguageCapability(s.model);
  const save = (patch: Parameters<typeof w.saveSettings>[0]) =>
    void w.saveSettings(patch, null);
  return (
    <div className="quick-settings">
      <label className="quick-row">
        <span>
          <Mic /> Microphone
        </span>
        <select
          aria-label="Microphone"
          value={s.inputDeviceId}
          disabled={busy || w.saving}
          onChange={(e) =>
            save({
              inputDeviceId: e.target.value,
              inputDeviceLabel:
                w.devices.find((device) => device.deviceId === e.target.value)
                  ?.label ?? "Microphone",
            })
          }
        >
          {!w.devices.some((device) => device.deviceId === s.inputDeviceId) && (
            <option value={s.inputDeviceId}>
              {s.inputDeviceLabel} (not listed)
            </option>
          )}
          {w.devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label className="quick-row">
        <span>
          <AudioLines /> Language
        </span>
        <select
          aria-label="Dictation language"
          value={s.language}
          disabled={busy || w.saving || !languageCapability.canSelectLanguage}
          onChange={(e) => save({ language: e.target.value })}
        >
          {languageCapability.languages.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="quick-row">
        <span>
          <Keyboard /> Shortcut
        </span>
        <button
          className="shortcut-key"
          title="Configure dictation shortcut"
          disabled={busy}
          onClick={() =>
            w.shortcutStatus.method === "portal"
              ? void w.action(() => bridge.configureShortcut())
              : onNavigate("settings")
          }
        >
          <kbd>{w.shortcutStatus.accelerator || s.shortcut}</kbd>
        </button>
      </div>
      <div className="quick-row">
        <span>Spoken corrections</span>
        <Toggle
          label="Spoken corrections"
          value={s.magicEnabled && s.magicPreset === "spoken-corrections"}
          disabled={busy || w.saving}
          onChange={() =>
            save(
              !(s.magicEnabled && s.magicPreset === "spoken-corrections")
                ? {
                    magicEnabled: true,
                    magicPreset: "spoken-corrections",
                    magicAllowInferences: false,
                    memoryPolicy: "balanced",
                  }
                : { magicEnabled: false },
            )
          }
        />
      </div>
      <div className="quick-divider" />
      <div className="quick-row">
        <span>Paste automatically</span>
        <Toggle
          label="Paste automatically"
          value={s.autoPaste}
          disabled={w.saving || busy}
          onChange={() => save({ autoPaste: !s.autoPaste })}
        />
      </div>
      <div className="quick-row">
        <span>Keep speech ready</span>
        <Toggle
          label="Keep speech ready"
          value={s.preloadModel}
          disabled={w.saving || busy}
          onChange={() => save({ preloadModel: !s.preloadModel })}
        />
      </div>
      <div className="quick-row">
        <span>Appearance</span>
        <button
          className="sheet-icon"
          aria-label="Switch color theme"
          title="Switch color theme"
          disabled={w.saving}
          onClick={() =>
            save({
              theme:
                document.documentElement.dataset.theme === "dark"
                  ? "light"
                  : "dark",
            })
          }
        >
          {s.theme === "light" ? <Moon /> : <Sun />}
        </button>
      </div>
    </div>
  );
}
