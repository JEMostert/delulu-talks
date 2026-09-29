import { microphoneSelection } from "../microphoneSelection";
import type { AppSettings, MicrophoneDevice } from "../types";

export function MicrophoneNotice({
  settings,
  devices,
}: {
  settings: AppSettings;
  devices: MicrophoneDevice[];
}) {
  const selection = microphoneSelection(settings, devices);
  if (!selection.message) return null;
  return (
    <span
      role={selection.state === "missing" ? "alert" : "status"}
      className="text-[11px] text-muted break-words"
    >
      {selection.message}
    </span>
  );
}
