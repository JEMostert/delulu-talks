import { expect, test } from "bun:test";
import { AUTO_LANGUAGE, SPEECH_TIERS, speechTierById } from "../../src/data";
import {
  speechLanguageCapability,
  supportedSpeechLanguage,
} from "../../src/speechCapabilities";

test("three sizes are offered smallest first, with Medium recommended", () => {
  expect(SPEECH_TIERS.map((tier) => tier.id)).toEqual([
    "small",
    "medium",
    "large",
  ]);
  expect(
    SPEECH_TIERS.filter((tier) => "recommended" in tier).map((tier) => tier.id),
  ).toEqual<string[]>([speechTierById("medium").id]);
});

test("Small offers four forced languages and no detection", () => {
  const small = speechLanguageCapability("small", "r2t2");
  expect(small.canRequestAutomaticLanguage).toBe(false);
  expect(small.languages.map(([code]) => code)).toEqual([
    "en",
    "de",
    "fr",
    "es",
  ]);
});

test("Medium is English or automatic detection", () => {
  const medium = speechLanguageCapability("medium", "r2t2");
  expect(medium.canRequestAutomaticLanguage).toBe(true);
  expect(medium.languages.map(([code]) => code)).toEqual(["en"]);
});

test("switching size keeps a language the new model accepts", () => {
  expect(supportedSpeechLanguage("small", "r2t2", "fr")).toBe("fr");
  expect(supportedSpeechLanguage("small", "r2t2", AUTO_LANGUAGE)).toBe("en");
  expect(supportedSpeechLanguage("medium", "r2t2", "fr")).toBe(AUTO_LANGUAGE);
  expect(supportedSpeechLanguage("medium", "r2t2", "en")).toBe("en");
  expect(supportedSpeechLanguage("large", "r2t2", "nl")).toBe("nl");
  expect(supportedSpeechLanguage("large", "r2t2", AUTO_LANGUAGE)).toBe(
    AUTO_LANGUAGE,
  );
  // R2T2 on MLX takes a selected language only.
  expect(supportedSpeechLanguage("large", "r2t2Mlx", AUTO_LANGUAGE)).toBe("en");
});
