import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, LANGUAGES, MODELS } from "../../src/data";
import { speechLanguageCapability } from "../../src/speechCapabilities";

describe("speech language capabilities", () => {
  for (const model of MODELS) {
    test(`${model.id} offers explicit selection including persisted Dutch and default English`, () => {
      const capability = speechLanguageCapability(model.id);
      expect(capability.canSelectLanguage).toBe(true);
      expect(capability.languages).toBe(LANGUAGES);
      const choices = capability.languages.map(([code]) => code);
      expect(choices).toContain("nl");
      expect(choices).toContain(DEFAULT_SETTINGS.language);
      expect(new Set(choices).size).toBe(choices.length);
    });
  }
});
