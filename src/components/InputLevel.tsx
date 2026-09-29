import { useSyncExternalStore } from "react";
import { captureLevelStore, type CaptureLevelState } from "../captureLevel";

const descriptions: Record<CaptureLevelState, [string, string]> = {
  idle: ["Input level", "Start recording to monitor the selected microphone."],
  waiting: ["Waiting for input", "Speak into the selected microphone."],
  quiet: ["Silence or very quiet input", "Check the selected device, its hardware mute switch and input gain."],
  signal: ["Audio arriving", "The microphone is sending audio. Noise can also produce a signal."],
  muted: ["Input muted or unavailable", "The browser reports a muted or disabled audio track. Check device and system controls."],
  ended: ["Microphone input ended", "Stop recording and reconnect or select another input."],
  suspended: ["Audio capture suspended", "Stop and restart recording to resume audio capture."],
  stalled: ["No audio samples arriving", "Stop recording and check the device connection."],
};

export function InputLevel() {
  const value = useSyncExternalStore(
    captureLevelStore.subscribe,
    captureLevelStore.getSnapshot,
    captureLevelStore.getServerSnapshot,
  );
  const [label, advice] = descriptions[value.state];
  return (
    <div className="mx-3.5 mt-2.5 p-3 rounded-xl border border-line bg-input">
      <div className="flex justify-between gap-3 text-[11px]">
        <span role="status" aria-live="polite" aria-atomic="true">{label}</span>
        <span className="font-mono text-muted" aria-hidden="true">
          {value.state === "idle" ? "—" : `${value.db <= -60 ? "≤ −60" : value.db} dBFS`}
        </span>
      </div>
      <div
        role="meter"
        aria-label="Live microphone level"
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={value.db}
        aria-valuetext={`${label}, ${value.db <= -60 ? "at or below minus 60" : value.db} decibels relative to full scale`}
        className="h-2 mt-2 overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150 motion-reduce:transition-none"
          style={{ width: `${((value.db + 60) / 60) * 100}%` }}
        />
      </div>
      <p className="text-[11px] text-muted mt-2">{advice}</p>
      {value.state !== "idle" && (
        <p className="text-[10px] text-subtle mt-1">
          Silent samples cannot reveal a physical mute switch. Levels do not establish speech quality.
        </p>
      )}
    </div>
  );
}
