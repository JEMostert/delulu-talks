import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerSettingsIpc(
  { handle }: IpcRegistrar,
  {
    storage,
    shortcut,
    persistSettings,
    ruleUsage,
  }: Pick<
    IpcDependencies,
    "storage" | "shortcut" | "persistSettings" | "ruleUsage"
  >,
): void {
  const ruleIds = () =>
    storage.getSettings().customWords.map((rule) => rule.id);
  handle("settings:get", () => storage.getSettings());
  handle("rules:usage", () => ruleUsage.get(ruleIds()));
  handle("rules:resetUsage", () => {
    ruleUsage.reset();
    return ruleUsage.get(ruleIds());
  });
  handle("settings:update", (_event, value: unknown) => persistSettings(value));
  handle("shortcut:status", () => shortcut.getStatus());
  handle("shortcut:configure", () => shortcut.configure());
}
