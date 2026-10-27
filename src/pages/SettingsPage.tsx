import { useEffect, useState } from "react";
import { Tabs } from "../components/ui";
import type {
  AppSettings,
  DictationStatus,
  MagicStatus,
  MicrophoneDevice,
  PlatformCapabilities,
  ShortcutStatus,
  UpdateStatus,
} from "../types";
import type { SectionProps } from "./settings/shared";
import { GeneralSection } from "./settings/GeneralSection";
import { SpeechSection } from "./settings/SpeechSection";
import { OutputSection } from "./settings/OutputSection";
import { RewritingSection } from "./settings/RewritingSection";
import { PrivacySection } from "./settings/PrivacySection";
import { AdvancedSection } from "./settings/AdvancedSection";

const SECTIONS = [
  ["general", "General"],
  ["speech", "Speech"],
  ["output", "Output"],
  ["rewriting", "Rewriting"],
  ["privacy", "Privacy"],
  ["advanced", "Advanced"],
] as const;
type Section = (typeof SECTIONS)[number][0];

type Props = {
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
};

export function SettingsPage(props: Props) {
  const { status, magicStatus, capabilities } = props;
  const [section, setSection] = useState<Section>("general");
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
        onChange={setSection}
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
        {section === "general" && (
          <GeneralSection
            {...common}
            devices={props.devices}
            capabilities={capabilities}
            shortcutStatus={props.shortcutStatus}
            onConfigureShortcut={props.onConfigureShortcut}
          />
        )}
        {section === "speech" && (
          <SpeechSection
            {...common}
            largeSpeechAvailable={!!capabilities?.largeSpeechAvailable}
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
        {section === "rewriting" && (
          <RewritingSection
            {...common}
            magicStatus={magicStatus}
            onSetupMagic={props.onSetupMagic}
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
            update={props.updateStatus}
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
            onCheckForUpdates={props.onCheckForUpdates}
            onDownloadUpdate={props.onDownloadUpdate}
            onInstallUpdate={props.onInstallUpdate}
          />
        )}
      </div>
    </div>
  );
}
