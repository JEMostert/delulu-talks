import { Download, Monitor, RefreshCw } from "lucide-react";
import { SettingRow } from "../../components/ui";
import type { PlatformCapabilities, UpdateStatus } from "../../types";
import { Group, SettingToggle, type SectionProps } from "./shared";

const THEMES = [
  ["system", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

/** How the app looks and starts, and its updates. */
export function AppSection({
  capabilities,
  update,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  ...section
}: SectionProps & {
  capabilities: PlatformCapabilities | null;
  update: UpdateStatus;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const { settings: s, saving, busy, save } = section;
  const mac = capabilities?.platform === "darwin";
  return (
    <>
      <Group title="Appearance">
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
      </Group>

      <Group title="Startup">
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

      <Group title="Updates">
        <SettingRow
          icon={RefreshCw}
          title={`Delulu Talks ${update.currentVersion || "development"}`}
          description={update.message}
        >
          <div className="inline-control">
            {update.phase === "available" ? (
              <button
                className="primary-button compact"
                onClick={onDownloadUpdate}
              >
                <Download />
                Download {update.version}
              </button>
            ) : update.phase === "downloaded" ? (
              <button
                className="primary-button compact"
                disabled={busy}
                onClick={onInstallUpdate}
              >
                Restart & update
              </button>
            ) : (
              <button
                className="secondary-button compact"
                disabled={
                  update.phase === "unsupported" ||
                  update.phase === "checking" ||
                  update.phase === "downloading"
                }
                onClick={onCheckForUpdates}
              >
                {update.phase === "checking" ? "Checking…" : "Check now"}
              </button>
            )}
          </div>
        </SettingRow>
        {update.phase === "downloading" && (
          <div className="setting-row">
            <progress
              aria-label="Update download"
              max={100}
              value={update.percent ?? 0}
            />
            <span className="caption tabular-nums">
              {Math.round(update.percent ?? 0)}%
            </span>
          </div>
        )}
        <div className="setting-row">
          <a
            className="text-button"
            href="https://github.com/JEMostert/delulu-talks/releases"
            target="_blank"
            rel="noreferrer"
          >
            Release notes ↗
          </a>
        </div>
      </Group>
    </>
  );
}
