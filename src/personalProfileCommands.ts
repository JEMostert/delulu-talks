import {
  personalProfileFromSettings,
  readPersonalProfiles,
  type PersonalProfileDocument,
  type PersonalProfileV1,
} from "./personalProfiles";
import type { AppSettings } from "./types";

export const PROFILE_STARTERS = [
  { id: "current", name: "Current settings", description: "Save the current language, delivery, vocabulary and rewrite settings." },
  { id: "code", name: "Code", description: "Current language, copy without automatic paste, identifier preservation, rewriting off." },
  { id: "terminal", name: "Terminal commands", description: "Current language, copy for manual review and paste, rewriting off. No command execution." },
  { id: "dutch", name: "Dutch messages", description: "Dutch recognition language, current delivery preferences and optional polish rewriting." },
  { id: "english", name: "English messages", description: "English recognition language, current delivery preferences and optional polish rewriting." },
  { id: "notes", name: "Long notes", description: "Current language, saved history, copy without automatic paste, structured rewrite preset." },
  { id: "imports", name: "Imported recordings", description: "Current language, saved history, copy without automatic paste, current rewrite preferences. Does not import a file." },
] as const;
export type ProfileStarterId = (typeof PROFILE_STARTERS)[number]["id"];
export type PersonalProfileCommand =
  | { action: "create"; name: string; starter: ProfileStarterId }
  | { action: "rename"; id: string; name: string }
  | { action: "delete"; id: string };

function profileName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128) {
    throw new Error("Give the profile a name of 1–128 characters.");
  }
  return value.trim();
}
function nameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

/** Prepare a starter from supported current settings; never apply it to the app. */
export function profileForStarter(settings: AppSettings, starter: ProfileStarterId, id: string, name: string): PersonalProfileV1 {
  if (!PROFILE_STARTERS.some((item) => item.id === starter)) throw new Error("Unknown profile starter.");
  const result = personalProfileFromSettings(settings, id, profileName(name));
  if (starter === "dutch" || starter === "english") {
    result.language = starter === "dutch" ? "nl" : "en";
    result.rewrite.preset = "polish";
  }
  if (["code", "terminal", "notes", "imports"].includes(starter)) {
    result.delivery.autoPaste = false;
    result.delivery.copyToClipboard = true;
  }
  if (starter === "code" || starter === "terminal") result.rewrite.enabled = false;
  if (starter === "notes" || starter === "imports") result.delivery.keepHistory = true;
  if (starter === "notes") result.rewrite.preset = "structured";
  return result;
}

/** Serial settings IPC calls this against the latest stored collection. */
export function changePersonalProfiles(settings: AppSettings, input: unknown, newId: () => string): PersonalProfileDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a profile command.");
  const command = input as Record<string, unknown>;
  const current = readPersonalProfiles(settings.personalProfiles);
  if (current.status !== "supported") throw new Error("These profiles use a newer schema and are read-only in this app.");
  const document = current.document;
  const profiles = document.profiles;
  if (command.action === "create") {
    const name = profileName(command.name);
    if (profiles.some((profile) => nameKey(profile.name) === nameKey(name))) throw new Error("A profile with this name already exists. Choose another name.");
    if (profiles.length >= 128) throw new Error("The profile limit (128) has been reached.");
    const starter = PROFILE_STARTERS.find((item) => item.id === command.starter);
    if (!starter) throw new Error("Unknown profile starter.");
    profiles.push(profileForStarter(settings, starter.id, newId(), name));
  } else if (command.action === "rename" || command.action === "delete") {
    if (typeof command.id !== "string") throw new Error("Expected a profile ID.");
    const index = profiles.findIndex((profile) => profile.id === command.id);
    if (index < 0) throw new Error("This profile no longer exists. Refresh and try again.");
    if (command.action === "delete") profiles.splice(index, 1);
    else {
      const name = profileName(command.name);
      if (profiles.some((profile, position) => position !== index && nameKey(profile.name) === nameKey(name))) throw new Error("A profile with this name already exists. Choose another name.");
      profiles[index] = { ...profiles[index], name };
    }
  } else throw new Error("Unknown profile command.");
  // Reader validates the final collection while retaining extra fields/bytes.
  return readPersonalProfiles(document).document as PersonalProfileDocument;
}
