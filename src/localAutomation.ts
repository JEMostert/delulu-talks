export const AUTOMATION_CAPABILITIES = [
  "events:status", "transcripts:read", "audio:transcribe", "rewrite:preview",
  "profiles:write", "diagnostics:read",
] as const;
export type AutomationCapability = typeof AUTOMATION_CAPABILITIES[number];
export type AutomationGrant = {
  id: string;
  name: string;
  capabilities: AutomationCapability[];
  directories: string[];
  createdAt: number;
};
export type AutomationStatus = {
  available: boolean;
  enabled: boolean;
  url: string | null;
  connectionFile: string | null;
  integrations: AutomationGrant[];
  error?: string;
};
export type AutomationGrantRequest = Pick<AutomationGrant, "name" | "capabilities" | "directories">;
export type LocalAutomationApi = {
  getAutomationStatus(): Promise<AutomationStatus>;
  setAutomationEnabled(enabled: boolean): Promise<AutomationStatus>;
  grantAutomation(request: AutomationGrantRequest): Promise<AutomationGrant & { token: string }>;
  revokeAutomation(id: string): Promise<AutomationStatus>;
};
