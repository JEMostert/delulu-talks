import { systemPreferences } from "electron";
import type { MicrophonePermission } from "../../src/types";

const microphoneSettings =
  "System Settings → Privacy & Security → Microphone";

export function getMicrophonePermission(): MicrophonePermission {
  if (process.platform !== "darwin") {
    return {
      state: "not-applicable",
      canRequestCapture: true,
      detail: "Microphone access is requested when dictation starts.",
    };
  }

  try {
    const state = systemPreferences.getMediaAccessStatus("microphone");
    switch (state) {
      case "not-determined":
        return {
          state,
          canRequestCapture: true,
          detail:
            "Start dictation to request microphone access, then allow Delulu Talks in the macOS prompt.",
        };
      case "granted":
        return {
          state,
          canRequestCapture: true,
          detail: "macOS has granted microphone access to Delulu Talks.",
        };
      case "denied":
        return {
          state,
          canRequestCapture: false,
          detail: `Enable Delulu Talks in ${microphoneSettings}, then quit and reopen the app before trying again.`,
        };
      case "restricted":
        return {
          state,
          canRequestCapture: false,
          detail: `macOS restricts microphone access. Check ${microphoneSettings} and ask your device administrator to allow access, then quit and reopen Delulu Talks.`,
        };
      default:
        return {
          state: "unknown",
          canRequestCapture: false,
          detail: `macOS could not determine microphone access. Check Delulu Talks in ${microphoneSettings}, then quit and reopen the app before trying again.`,
        };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      state: "unknown",
      canRequestCapture: false,
      detail: `Could not read macOS microphone permission: ${reason}. Check Delulu Talks in ${microphoneSettings}, then quit and reopen the app before trying again.`,
    };
  }
}
