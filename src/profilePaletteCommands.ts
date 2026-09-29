import { readPersonalProfiles, type PersonalProfileV1 } from "./personalProfiles";
import type { AppSettings } from "./types";
import type { PaletteCommand } from "./components/CommandPalette";

/** Commands use the same activation boundary as Settings, never reimplement profile application. */
export function profilePaletteCommands(settings: AppSettings, activate: (profile: PersonalProfileV1) => Promise<boolean>, options: {
  disabled?: string;
  activeId?: string;
  global?: () => Promise<boolean>;
  validate: (profile: PersonalProfileV1) => void;
}): PaletteCommand[] {
  try {
    const current = readPersonalProfiles(settings.personalProfiles);
    if (current.status !== "supported") return [{ id: "profiles-unavailable", label: "Profiles require a newer app version", disabled: "Saved profile data is preserved; use a compatible version to activate it.", run: () => {} }];
    const commands: PaletteCommand[] = current.document.profiles.map((profile) => {
      let disabled = options.disabled;
      try { options.validate(profile); } catch (reason) {
        disabled = reason instanceof Error ? reason.message : String(reason);
      }
      return {
        id: `profile-${profile.id}`, label: `Use profile: ${profile.name}`,
        detail: `${profile.language} · ${profile.vocabulary.rules.length} rules${options.activeId === profile.id ? " · currently active" : ""}`,
        keywords: "switch choose personal workflow language delivery vocabulary",
        disabled, run: () => activate(profile),
      };
    });
    if (options.global && options.activeId) commands.push({ id: "profile-global", label: "Return to global settings", detail: "Restore the settings saved before profile activation.", keywords: "switch profile default", disabled: options.disabled, run: options.global });
    return commands;
  } catch (reason) {
    return [{ id: "profiles-unavailable", label: "Profile data unavailable", disabled: reason instanceof Error ? reason.message : String(reason), run: () => {} }];
  }
}
