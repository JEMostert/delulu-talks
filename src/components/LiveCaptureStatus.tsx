import type { AppSettings, DictationStatus, MagicStatus, MicrophoneDevice, ModelResidency, PlatformCapabilities, ShortcutStatus } from "../types";

const residency: Record<ModelResidency, string> = {
  unknown: "Residency not reported", unloaded: "Unloaded", loading: "Loading",
  resident: "Resident", unloading: "Unloading",
};

function runtime(status: DictationStatus | MagicStatus): string {
  const state = residency[status.residency ?? "unknown"];
  const device = status.device || "device not reported";
  const backend = status.capabilities?.backend;
  return `${state} · ${backend ? `${backend} · ` : ""}${device}${status.warmup === "warming" ? " · warming up" : ""}`;
}

export function LiveCaptureStatus({ settings, speech, rewrite, shortcut, devices, capabilities }: {
  settings: AppSettings;
  speech: DictationStatus;
  rewrite: MagicStatus;
  shortcut: ShortcutStatus;
  devices: MicrophoneDevice[];
  capabilities?: PlatformCapabilities | null;
}) {
  const selected = devices.find((device) => device.deviceId === settings.inputDeviceId);
  const missing = settings.inputDeviceId !== "default" && !selected;
  const microphone = settings.inputDeviceLabel || selected?.label || "System default";
  const micState = speech.phase === "listening" ? "Capturing" : missing ? "Selected device unavailable" : "Selected for next capture";
  const delivery = settings.autoPaste ? "Automatic paste requested" : settings.copyToClipboard ? "Copy to clipboard" : "Review in app";
  const method = capabilities?.pasteMethod;
  const deliveryCapability = method === "clipboard-only" ? "Clipboard only; automatic paste unavailable" : method ? `Paste method: ${method}` : "Paste capability not reported";
  return <section aria-label="Live capture status" className="mb-3 rounded-xl border border-line bg-soft px-3.5 py-2.5">
    <dl className="grid grid-cols-[1fr_1fr_1.5fr_1fr] gap-3.5 m-0 max-[1150px]:grid-cols-2 max-[700px]:grid-cols-1 text-[11px]">
      <div className="min-w-0"><dt className="text-muted">Microphone · {micState}</dt><dd className="m-0 mt-1 break-words">{microphone}</dd></div>
      <div className="min-w-0"><dt className="text-muted">Shortcut · {shortcut.registered ? "Registered" : "Unavailable"}</dt><dd className="m-0 mt-1 break-words" title={shortcut.message}>{shortcut.accelerator || settings.shortcut} · {shortcut.method === "portal" ? "Desktop portal" : "Native"}</dd></div>
      <div className="min-w-0"><dt className="text-muted">Models · reported residency and device</dt><dd className="m-0 mt-1 break-words">Speech: {runtime(speech)}<br />Rewriting: {runtime(rewrite)}</dd></div>
      <div className="min-w-0"><dt className="text-muted">Delivery · {delivery}</dt><dd className="m-0 mt-1 break-words">{deliveryCapability}</dd></div>
    </dl>
  </section>;
}
