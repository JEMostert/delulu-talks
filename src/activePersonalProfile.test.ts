import { expect, test } from "bun:test";
import {
  activatePersonalProfile,
  effectiveProfileSettings,
  readActivePersonalProfile,
} from "./activePersonalProfile";
import { DEFAULT_SETTINGS } from "./data";
import { personalProfileFromSettings } from "./personalProfiles";
import { personalizeWithUsage } from "./personalization";
import type { AppSettings, CustomWord } from "./types";

const scopedRules = (prefix: string): CustomWord[] => [
  {
    id: `${prefix}-nl`,
    kind: "shortcut",
    term: "Dutch note",
    soundsLike: "note block",
    replacement: `${prefix} Nederlands`,
    enabled: true,
    language: "nl",
  },
  {
    id: `${prefix}-en`,
    kind: "shortcut",
    term: "English note",
    soundsLike: "note block",
    replacement: `${prefix} English`,
    enabled: true,
    language: "en",
  },
];

test("profile activation, persisted snapshots and global restore retain vocabulary scopes", () => {
  const settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    language: "en",
    customWords: scopedRules("global"),
  };
  const profile = personalProfileFromSettings(
    {
      ...settings,
      language: "nl",
      customWords: scopedRules("profile"),
    },
    "bilingual",
    "Bilingual notes",
  );
  settings.personalProfiles = { schemaVersion: 1, profiles: [profile] };
  const activated: AppSettings = {
    ...settings,
    ...activatePersonalProfile(settings, {
      action: "activate",
      id: profile.id,
      expectedProfile: profile,
      expectedCurrentSettings: effectiveProfileSettings(settings),
    }),
  };

  expect(activated.customWords.map((rule) => rule.language)).toEqual([
    "nl",
    "en",
  ]);
  expect(
    personalizeWithUsage("note block", activated.customWords, "nl"),
  ).toEqual({
    text: "profile Nederlands",
    counts: { "profile-nl": 1 },
  });
  expect(
    personalizeWithUsage("note block", activated.customWords, "en"),
  ).toEqual({
    text: "profile English",
    counts: { "profile-en": 1 },
  });
  expect(
    personalizeWithUsage("note block", activated.customWords, "de").text,
  ).toBe("note block");

  const restoredMetadata = readActivePersonalProfile(
    JSON.parse(JSON.stringify(activated.activePersonalProfile)),
  );
  expect(restoredMetadata).toEqual(activated.activePersonalProfile!);
  expect(
    restoredMetadata!.appliedSettings.customWords.map((rule) => rule.language),
  ).toEqual(["nl", "en"]);
  expect(restoredMetadata!.globalSettings.customWords).toEqual(
    settings.customWords,
  );
  const reloaded = { ...activated, activePersonalProfile: restoredMetadata };
  const global: AppSettings = {
    ...reloaded,
    ...activatePersonalProfile(reloaded, {
      action: "global",
      expectedCurrentSettings: effectiveProfileSettings(reloaded),
    }),
  };
  expect(global.activePersonalProfile).toBeNull();
  expect(global.language).toBe("en");
  expect(global.customWords).toEqual(settings.customWords);
  expect(
    personalizeWithUsage("note block", global.customWords, "nl").text,
  ).toBe("global Nederlands");
  expect(
    personalizeWithUsage("note block", global.customWords, "en").text,
  ).toBe("global English");
  expect(profile.vocabulary.rules.map((rule) => rule.language)).toEqual([
    "nl",
    "en",
  ]);
});
