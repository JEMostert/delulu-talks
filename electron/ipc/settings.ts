import { activatePersonalProfile } from "../../src/activePersonalProfile";
import { changePersonalProfiles } from "../../src/personalProfileCommands";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerSettingsIpc({ handle }: IpcRegistrar, { storage, shortcut, persistSettings, ruleUsage, applySettings, settingsQueue, dictation, asr, paste }: Pick<IpcDependencies, "storage" | "shortcut" | "persistSettings" | "ruleUsage" | "applySettings" | "settingsQueue" | "dictation" | "asr" | "paste">): void {
const ruleIds = () => storage.getSettings().customWords.map((rule) => rule.id);
handle("settings:get", () => storage.getSettings());
handle("rules:usage", () => ruleUsage.get(ruleIds()));
handle("rules:resetUsage", () => {
    ruleUsage.reset();
    return ruleUsage.get(ruleIds());
  });
handle("settings:update", (_event, value: unknown) => persistSettings(value));
handle("profiles:manage", (_event, command: unknown) =>
    settingsQueue.run(() =>
      applySettings({
        personalProfiles: changePersonalProfiles(
          storage.getSettings(),
          command,
          randomUUID,
        ),
      }),
    ),
  );
handle("profiles:activate", (_event, command: unknown) => settingsQueue.run(() => {
  if (dictation.isActive || asr.isBusy || paste.isBusy) throw new Error("Finish the current recording or model operation first");
  return applySettings(activatePersonalProfile(storage.getSettings(), command), true);
}));
handle("shortcut:status", () => shortcut.getStatus());
handle("shortcut:configure", () => shortcut.configure());
}
