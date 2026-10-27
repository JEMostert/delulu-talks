import type React from "react";
import { Toggle } from "../../components/ui";
import type { AppSettings } from "../../types";

/** What every settings section receives from the page. */
export type SectionProps = {
  settings: AppSettings;
  saving: boolean;
  /** Speech or rewriting is working; engine-bound settings wait. */
  busy: boolean;
  save: (patch: Partial<AppSettings>) => void;
};

type BooleanSetting = {
  [K in keyof AppSettings]-?: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];

/** A titled list of rows: the one structure every settings section uses. */
export function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pref-group">
      <h3>{title}</h3>
      <div className="pref-list">{children}</div>
    </section>
  );
}

/** A switch bound to one boolean setting. */
export function SettingToggle({
  settings,
  saving,
  save,
  name,
  label,
  disabled = false,
}: SectionProps & {
  name: BooleanSetting;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Toggle
      value={!!settings[name]}
      label={label}
      disabled={saving || disabled}
      onChange={() => save({ [name]: !settings[name] })}
    />
  );
}
