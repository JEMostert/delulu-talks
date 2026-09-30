import { systemPreferences } from "electron";
import type { AccessibilityPermission } from "../../src/types";

const accessibilitySettings =
  "System Settings → Privacy & Security → Accessibility";

export function getAccessibilityPermission(
  platform: NodeJS.Platform = process.platform,
): AccessibilityPermission {
  if (platform !== "darwin") {
    return {
      state: "not-applicable",
      canAttemptPaste: true,
      detail: "macOS Accessibility permission does not apply on this platform.",
    };
  }

  try {
    if (systemPreferences.isTrustedAccessibilityClient(false)) {
      return {
        state: "granted",
        canAttemptPaste: true,
        detail:
          "macOS has granted Accessibility access to Delulu Talks for automatic paste.",
      };
    }
    return {
      state: "denied",
      canAttemptPaste: false,
      detail: `Enable Delulu Talks in ${accessibilitySettings}, then quit and reopen the app to use automatic paste.`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: "unknown",
      canAttemptPaste: false,
      detail: `Could not read macOS Accessibility permission: ${reason}. Enable Delulu Talks in ${accessibilitySettings}, then quit and reopen the app to use automatic paste.`,
    };
  }
}
