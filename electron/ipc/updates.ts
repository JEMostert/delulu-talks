import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerUpdatesIpc(
  { handle }: IpcRegistrar,
  { updates }: Pick<IpcDependencies, "updates">,
): void {
  handle("updates:get", () => updates.getStatus());
  handle("updates:check", () => updates.check());
  handle("updates:download", () => updates.download());
  handle("updates:install", () => updates.install());
}
