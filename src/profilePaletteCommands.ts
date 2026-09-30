import {
  readPersonalProfiles,
  type PersonalProfileV1,
} from "./personalProfiles";
import type { AppSettings } from "./types";
import type { PaletteCommand } from "./components/CommandPalette";
import {
  effectiveProfileSettings,
  profileActivationSettings,
  type ProfileEffectiveSettings,
} from "./activePersonalProfile";
import { LANGUAGES } from "./data";

function preview(
  before: ProfileEffectiveSettings,
  after: ProfileEffectiveSettings,
) {
  const language = (settings: ProfileEffectiveSettings) =>
    LANGUAGES.find(([code]) => code === settings.language)?.[1] ??
    settings.language;
  const delivery = (settings: ProfileEffectiveSettings) =>
    `${settings.autoPaste ? "Automatic paste requested" : "Automatic paste off"} · ${settings.copyToClipboard ? "Copy on" : "Copy off"} · ${settings.keepHistory ? "History on" : "History off"}`;
  const words = (settings: ProfileEffectiveSettings) =>
    `${settings.customWords.length} rules${
      settings.customWords.length
        ? `: ${settings.customWords
            .slice(0, 5)
            .map((word) => word.term)
            .join(", ")}${settings.customWords.length > 5 ? "…" : ""}`
        : ""
    }`;
  const rewrite = (settings: ProfileEffectiveSettings) =>
    `${settings.magicEnabled ? "Automatic rewriting on" : "On-demand rewriting only"} · ${settings.magicModel} · ${settings.magicPreset} · ${settings.magicAllowInferences ? "Inferences allowed" : "No added inferences"}`;
  return [
    {
      label: "Recognition language",
      before: language(before),
      after: language(after),
    },
    {
      label: "Delivery and retention",
      before: delivery(before),
      after: delivery(after),
    },
    { label: "Vocabulary", before: words(before), after: words(after) },
    {
      label: "Optional rewriting",
      before: rewrite(before),
      after: rewrite(after),
    },
  ];
}

/** Commands use the same activation boundary as Settings, never reimplement profile application. */
export function profilePaletteCommands(
  settings: AppSettings,
  activate: (profile: PersonalProfileV1) => Promise<boolean>,
  options: {
    disabled?: string;
    activeId?: string;
    global?: () => Promise<boolean>;
  },
): PaletteCommand[] {
  try {
    const current = readPersonalProfiles(settings.personalProfiles);
    if (current.status !== "supported")
      return [
        {
          id: "profiles-unavailable",
          label: "Profiles require a newer app version",
          disabled:
            "Saved profile data is preserved; use a compatible version to activate it.",
          run: () => {},
        },
      ];
    const commands: PaletteCommand[] = current.document.profiles.map(
      (profile) => {
        let disabled = options.disabled;
        let rows: PaletteCommand["preview"];
        try {
          rows = preview(
            effectiveProfileSettings(settings),
            profileActivationSettings(profile),
          );
        } catch (reason) {
          disabled = reason instanceof Error ? reason.message : String(reason);
        }
        return {
          id: `profile-${profile.id}`,
          label: `Use profile: ${profile.name}`,
          detail: `${profile.language} · ${profile.vocabulary.rules.length} rules${options.activeId === profile.id ? " · currently active" : ""}`,
          keywords:
            "switch choose personal workflow language delivery vocabulary",
          disabled,
          preview: rows,
          confirmationLabel: "Switch profile",
          run: () => activate(profile),
        };
      },
    );
    if (options.global && options.activeId && settings.activePersonalProfile)
      commands.push({
        id: "profile-global",
        label: "Return to global settings",
        detail: "Restore the settings saved before profile activation.",
        keywords: "switch profile default",
        disabled: options.disabled,
        preview: preview(
          effectiveProfileSettings(settings),
          settings.activePersonalProfile.globalSettings,
        ),
        confirmationLabel: "Restore global settings",
        run: options.global,
      });
    return commands;
  } catch (reason) {
    return [
      {
        id: "profiles-unavailable",
        label: "Profile data unavailable",
        disabled: reason instanceof Error ? reason.message : String(reason),
        run: () => {},
      },
    ];
  }
}
