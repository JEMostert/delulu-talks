import type { AppSettings, MicrophoneDevice } from "./types";

export function microphoneSelection(
  settings: Pick<AppSettings, "inputDeviceId" | "inputDeviceLabel">,
  devices: MicrophoneDevice[],
): {
  state: "available" | "unknown" | "missing" | "renamed";
  message: string | null;
} {
  if (!settings.inputDeviceId || settings.inputDeviceId === "default")
    return { state: "available", message: null };
  const selected = devices.find(
    (device) => device.deviceId === settings.inputDeviceId,
  );
  if (selected) {
    if (
      selected.labelKnown !== false &&
      selected.label !== settings.inputDeviceLabel
    )
      return {
        state: "renamed",
        message: `“${settings.inputDeviceLabel}” is now named “${selected.label}”. The selected input is unchanged.`,
      };
    return { state: "available", message: null };
  }
  const known = devices.some(
    (device) =>
      device.labelKnown === true ||
      (device.deviceId !== "default" &&
        !!device.deviceId &&
        device.labelKnown !== false),
  );
  return known
    ? {
        state: "missing",
        message: `“${settings.inputDeviceLabel}” is unavailable. Reconnect it or select another microphone before recording.`,
      }
    : {
        state: "unknown",
        message: `“${settings.inputDeviceLabel}” is not currently listed. Microphone permission may be hiding device details; recording will check the selected input.`,
      };
}
