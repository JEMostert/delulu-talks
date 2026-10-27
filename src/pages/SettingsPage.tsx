import { useEffect } from "react";
import { Tabs } from "../components/ui";
import type {
  AppSettings,
  DictationStatus,
  MagicStatus,
  MicrophoneDevice,
  PlatformCapabilities,
  SettingsSection,
  ShortcutStatus,
  UpdateStatus,
} from "../types";
import type { SectionProps } from "./settings/shared";
import { DictationSection } from "./settings/DictationSection";
import { OutputSection } from "./settings/OutputSection";
import { RewritingSection } from "./settings/RewritingSection";
import { AppSection } from "./settings/AppSection";
import { PrivacySection } from "./settings/PrivacySection";
import { AdvancedSection } from "./settings/AdvancedSection";

/** One section per feature; each holds its switch, its model and its options. */
const SECTIONS: readonly (readonly [SettingsSection, string])[] = [
  ["dictation", "Dictation"],
  ["rewrite", "Rewrite"],
  ["output", "Output"],
  ["app", "App"],
  ["privacy", "Privacy"],
  ["advanced", "Advanced"],
];

type Props = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  settings: AppSettings;
  devices: MicrophoneDevice[];
  capabilities: PlatformCapabilities | null;
  shortcutStatus: ShortcutStatus;
  updateStatus: UpdateStatus;
  status: DictationStatus;
  magicStatus: MagicStatus;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<boolean>;
  onConfigureShortcut: () => void;
  onAuthorizePaste: () => void;
  onTestPaste: () => void;
  onTestCaptureCue: () => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  onSetup: () => void;
  onCancelSetup?: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onSetupMagic: () => void;
  onCancelSetupMagic?: () => void;
  onLoadMagic: () => void;
  onUnloadMagic: () => void;
  onReset: () => void;
  /** First-run setup: closes Settings once speech is ready. */
  onDone?: () => void;
};

export function SettingsPage(props: Props) {
  const { section, status, magicStatus, capabilities } = props;
  useEffect(() => {
    const content = document.getElementById("page-content");
    if (content) content.scrollTop = 0;
  }, [section]);
  const common: SectionProps = {
    settings: props.settings,
    saving: props.saving,
    busy:
      ["preparing", "loading", "listening", "paused", "transcribing"].includes(
        status.phase,
      ) || ["preparing", "loading", "rewriting"].includes(magicStatus.phase),
    save: (patch) => void props.onSave(patch),
  };

  return (
    <div className="settings-layout">
      <Tabs
        className="settings-tabs"
        label="Settings sections"
        idPrefix="settings"
        tabs={SECTIONS}
        value={section}
        onChange={props.onSectionChange}
        trailing={
          <span className="settings-saving" aria-live="polite">
            {props.saving ? "Saving…" : ""}
          </span>
        }
      />
      <div
        className="settings-panel"
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
      >
        {section === "dictation" && (
          <DictationSection
            {...common}
            status={status}
            devices={props.devices}
            capabilities={capabilities}
            shortcutStatus={props.shortcutStatus}
            onConfigureShortcut={props.onConfigureShortcut}
            onSetup={props.onSetup}
            onCancelSetup={props.onCancelSetup}
            onDone={props.onDone}
          />
        )}
        {section === "rewrite" && (
          <RewritingSection
            {...common}
            magicStatus={magicStatus}
            onSetupMagic={props.onSetupMagic}
            onCancelSetupMagic={props.onCancelSetupMagic}
          />
        )}
        {section === "output" && (
          <OutputSection
            {...common}
            capabilities={capabilities}
            onAuthorizePaste={props.onAuthorizePaste}
            onTestPaste={props.onTestPaste}
            onTestCaptureCue={props.onTestCaptureCue}
          />
        )}
        {section === "app" && (
          <AppSection
            {...common}
            capabilities={capabilities}
            update={props.updateStatus}
            onCheckForUpdates={props.onCheckForUpdates}
            onDownloadUpdate={props.onDownloadUpdate}
            onInstallUpdate={props.onInstallUpdate}
          />
        )}
        {section === "privacy" && (
          <PrivacySection {...common} onSave={props.onSave} />
        )}
        {section === "advanced" && (
          <AdvancedSection
            {...common}
            status={status}
            magicStatus={magicStatus}
            speech={{
              onSetup: props.onSetup,
              onCancelSetup: props.onCancelSetup,
              onLoad: props.onLoad,
              onUnload: props.onUnload,
            }}
            rewriting={{
              onSetup: props.onSetupMagic,
              onCancelSetup: props.onCancelSetupMagic,
              onLoad: props.onLoadMagic,
              onUnload: props.onUnloadMagic,
            }}
            onReset={props.onReset}
          />
        )}
      </div>
    </div>
  );
}
