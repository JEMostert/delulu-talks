import { useId } from "react";
import type { AppSettings } from "../types";

export function DeliveryControl({
  settings,
  saving,
  busy,
  onChange,
}: {
  settings: AppSettings;
  saving: boolean;
  busy: boolean;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const id = useId();
  const value = settings.autoPaste
    ? "paste"
    : settings.copyToClipboard
      ? "clipboard"
      : "review";
  const caption =
    value === "paste"
      ? "Paste is attempted after transcription."
      : value === "clipboard"
        ? "Copy the result for manual paste."
        : "Keep the result in the app for review.";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[11px] text-muted">
        Destination
      </label>
      <select
        id={id}
        aria-describedby={`${id}-description`}
        className="w-full min-h-[34px] px-[9px] py-[7px] pr-[23px] text-[12px] bg-input"
        value={value}
        disabled={saving || busy}
        onChange={(event) => {
          switch (event.target.value) {
            case "paste":
              onChange({ autoPaste: true, copyToClipboard: true });
              break;
            case "clipboard":
              onChange({ autoPaste: false, copyToClipboard: true });
              break;
            case "review":
              onChange({ autoPaste: false, copyToClipboard: false });
              break;
          }
        }}
      >
        <option value="paste">Active text field (paste attempt)</option>
        <option value="clipboard">Clipboard</option>
        <option value="review">Review here</option>
      </select>
      <span id={`${id}-description`} className="text-[11px] text-muted">
        {caption}
      </span>
    </div>
  );
}
