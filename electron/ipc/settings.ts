import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerSettingsIpc(
  { handle }: IpcRegistrar,
  {
    storage,
    persistSettings,
    shortcut,
  }: Pick<
    IpcDependencies,
    | "storage"
    | "persistSettings"
    | "shortcut"
  >,
): void {
  handle("settings:get", () => storage.getSettings());
  handle("settings:update", (_event, value: unknown) => persistSettings(value));
  handle("shortcut:status", () => shortcut.getStatus());
  handle("shortcut:configure", () => shortcut.configure());
}
