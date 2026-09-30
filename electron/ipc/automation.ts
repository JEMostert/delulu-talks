import type { IpcRegistrar } from "./types";
import type { LocalAutomationService } from "../services/localAutomation";
import type { AutomationGrantRequest } from "../../src/localAutomation";
import type { WatchedImportService } from "../services/watchedImports";

export function registerAutomationIpc({ handle }: IpcRegistrar, automation: LocalAutomationService, watchedImports: WatchedImportService): void {
  handle("automation:status", () => automation.getStatus());
  handle("automation:enabled", (_event, enabled: boolean) => automation.setEnabled(enabled));
  handle("automation:grant", (_event, request: AutomationGrantRequest) => automation.grant(request));
  handle("automation:revoke", (_event, id: string) => automation.revoke(id));
  handle("automation:watches", () => watchedImports.get());
  handle("automation:addWatch", (_event, directory: string, autoRun: boolean) => watchedImports.add(directory, autoRun));
  handle("automation:toggleWatch", (_event, id: string, enabled: boolean) => watchedImports.setEnabled(id, enabled));
  handle("automation:removeWatch", (_event, id: string) => watchedImports.remove(id));
}
