import { readPersonalProfiles, type PersonalProfileV1 } from "./personalProfiles";
import type { AppSettings } from "./types";

export type ProfileEffectiveSettings = Pick<AppSettings,
  "language" | "autoPaste" | "copyToClipboard" | "keepHistory" | "customWords" |
  "magicEnabled" | "magicModel" | "magicPreset" | "magicAllowInferences">;
export type ActivePersonalProfile = {
  schemaVersion: 1;
  id: string;
  name: string;
  activatedAt: number;
  appliedSettings: ProfileEffectiveSettings;
  globalSettings: ProfileEffectiveSettings;
  sourceProfile: PersonalProfileV1;
};
export type ProfileActivationCommand =
  | { action: "activate"; id: string; expectedProfile: PersonalProfileV1; expectedCurrentSettings: ProfileEffectiveSettings }
  | { action: "global"; expectedCurrentSettings: ProfileEffectiveSettings };
export type CaptureProfileSnapshot = { label: string; settings: ProfileEffectiveSettings };

export function effectiveProfileSettings(settings: AppSettings): ProfileEffectiveSettings {
  return structuredClone({
    language: settings.language,
    autoPaste: settings.autoPaste,
    copyToClipboard: settings.copyToClipboard,
    keepHistory: settings.keepHistory,
    customWords: settings.customWords,
    magicEnabled: settings.magicEnabled,
    magicModel: settings.magicModel,
    magicPreset: settings.magicPreset,
    magicAllowInferences: settings.magicAllowInferences,
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function profileActivationSettings(profile: PersonalProfileV1): ProfileEffectiveSettings {
  readPersonalProfiles({ schemaVersion: 1, profiles: [profile] });
  if (profile.schemaVersion !== 1 || profile.decode.mode !== "backend-default") throw new Error("Custom decode controls cannot be activated by this app. Choose backend decoding defaults.");
  if (profile.context.mode !== "none") throw new Error("Context capture is not supported by profile activation. Choose no context; a profile cannot grant native permission.");
  if (!profile.technicalGrammar.preserveIdentifiers || profile.technicalGrammar.literalTerms.length) throw new Error("Only the built-in technical identifier protection is supported. Custom technical grammar is not available.");
  if (profile.rewrite.instructions?.trim()) throw new Error("Saved rewrite instructions are not supported by automatic profile activation. Use an existing preset.");
  return {
    language: profile.language,
    autoPaste: profile.delivery.autoPaste,
    copyToClipboard: profile.delivery.copyToClipboard,
    keepHistory: profile.delivery.keepHistory,
    customWords: profile.vocabulary.rules.map((rule) => ({
      id: rule.id, kind: rule.kind, term: rule.term.trim(), soundsLike: rule.soundsLike.trim(),
      replacement: rule.replacement, enabled: rule.enabled,
      ...(rule.language !== undefined ? { language: rule.language } : {}),
    })),
    magicEnabled: profile.rewrite.enabled,
    magicModel: profile.rewrite.model,
    magicPreset: profile.rewrite.preset,
    magicAllowInferences: profile.rewrite.allowInferences,
  };
}

export function readActivePersonalProfile(value: unknown): ActivePersonalProfile | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid active personal profile metadata; settings are preserved.");
  const entry = value as ActivePersonalProfile;
  if (entry.schemaVersion !== 1 || typeof entry.id !== "string" || !entry.id || typeof entry.name !== "string" || !entry.name || !Number.isFinite(entry.activatedAt)) throw new Error("Unsupported active personal profile metadata; settings are preserved.");
  profileActivationSettings(entry.sourceProfile);
  // Snapshot dictionaries are validated through the same supported contract.
  for (const snapshot of [entry.appliedSettings, entry.globalSettings]) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("Missing active profile settings snapshot; settings are preserved.");
    const source = entry.sourceProfile;
    profileActivationSettings({ ...source, language: snapshot.language,
      delivery: { autoPaste: snapshot.autoPaste, copyToClipboard: snapshot.copyToClipboard, keepHistory: snapshot.keepHistory },
      vocabulary: { rules: snapshot.customWords.map((rule) => ({ ...rule, kind: rule.kind ?? (rule.replacement ? "shortcut" : "correction") })) },
      rewrite: { enabled: snapshot.magicEnabled, model: snapshot.magicModel, preset: snapshot.magicPreset, allowInferences: snapshot.magicAllowInferences },
    });
  }
  return structuredClone(entry);
}

export function activeProfileLabel(settings: AppSettings): string {
  const active = settings.activePersonalProfile;
  if (!active) return "Global settings";
  const document = readPersonalProfiles(settings.personalProfiles);
  const saved = document.status === "supported" ? document.document.profiles.find((profile) => profile.id === active.id) : undefined;
  const name = saved?.name ?? active.name;
  const customized = canonical(effectiveProfileSettings(settings)) !== canonical(active.appliedSettings);
  let suffix = customized ? " · customized" : "";
  if (document.status === "unsupported") suffix += " · saved profiles read-only";
  else if (!saved) suffix += " · saved profile deleted";
  else if (canonical({ ...saved, name: "" }) !== canonical({ ...active.sourceProfile, name: "" })) suffix += " · saved profile changed";
  return `${name}${suffix}`;
}
export function captureProfileSnapshot(settings: AppSettings): CaptureProfileSnapshot {
  return { label: activeProfileLabel(settings), settings: effectiveProfileSettings(settings) };
}

/** Main calls this inside the settings queue after checking native capture idle. */
export function activatePersonalProfile(settings: AppSettings, input: unknown): Partial<AppSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a profile activation command.");
  const command = input as Record<string, unknown>;
  if (canonical(command.expectedCurrentSettings) !== canonical(effectiveProfileSettings(settings))) throw new Error("Active settings changed after the preview. Reopen the preview before switching profiles.");
  if (command.action === "global") {
    if (!settings.activePersonalProfile) return {};
    return { ...structuredClone(settings.activePersonalProfile.globalSettings), activePersonalProfile: null };
  }
  if (command.action !== "activate" || typeof command.id !== "string") throw new Error("Unknown profile activation command.");
  const result = readPersonalProfiles(settings.personalProfiles);
  if (result.status !== "supported") throw new Error("Newer-schema profiles cannot be activated in this app.");
  const profile = result.document.profiles.find((item) => item.id === command.id);
  if (!profile) throw new Error("This profile was deleted. Choose another profile.");
  if (canonical(profile) !== canonical(command.expectedProfile)) throw new Error("This profile changed after the preview. Reopen the activation preview before applying it.");
  const appliedSettings = profileActivationSettings(profile);
  return { ...appliedSettings, activePersonalProfile: {
    schemaVersion: 1, id: profile.id, name: profile.name, activatedAt: Date.now(),
    appliedSettings, sourceProfile: structuredClone(profile),
    globalSettings: settings.activePersonalProfile?.globalSettings ?? effectiveProfileSettings(settings),
  } };
}
