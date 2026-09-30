import type { IpcRegistrar } from "./types";
import type { LocalAutomationService } from "../services/localAutomation";
import type { AutomationGrantRequest } from "../../src/localAutomation";

export function registerAutomationIpc({ handle }: IpcRegistrar, automation: LocalAutomationService): void {
  handle("automation:status", () => automation.getStatus());
  handle("automation:enabled", (_event, enabled: boolean) => automation.setEnabled(enabled));
  handle("automation:grant", (_event, request: AutomationGrantRequest) => automation.grant(request));
  handle("automation:revoke", (_event, id: string) => automation.revoke(id));
}
