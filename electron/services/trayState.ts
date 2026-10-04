import type {
  DictationStatus,
  MagicStatus,
  ShortcutStatus,
  UpdateStatus,
} from "../../src/types";

export type TrayIconState =
  "idle" | "recording" | "busy" | "attention" | "update";

export type TrayState = {
  icon: TrayIconState;
  /** Shown as a disabled first menu row; sublabels do not render on Linux/Windows. */
  statusLine: string;
  tooltip: string;
};

/** Recording > busy > attention > update-ready > idle. */
export function trayState({
  speech,
  rewrite,
  shortcut,
  update,
  delivering = false,
}: {
  speech: DictationStatus;
  rewrite: MagicStatus;
  shortcut?: ShortcutStatus | null;
  update?: UpdateStatus | null;
  delivering?: boolean;
}): TrayState {
  const result = (icon: TrayIconState, statusLine: string): TrayState => ({
    icon,
    statusLine,
    tooltip: `Delulu Talks — ${statusLine}`,
  });
  if (speech.phase === "listening") return result("recording", "● Recording");
  if (speech.phase === "paused")
    return result("recording", "Paused — microphone open");
  if (speech.phase === "transcribing") return result("busy", "Transcribing…");
  if (speech.phase === "preparing") return result("busy", "Preparing…");
  if (speech.phase === "loading") return result("busy", "Loading speech…");
  if (rewrite.phase === "rewriting") return result("busy", "Rewriting…");
  if (rewrite.phase === "loading" || rewrite.phase === "preparing")
    return result("busy", "Loading rewriting…");
  if (delivering) return result("busy", "Pasting…");
  if (speech.engine === "settingUp")
    return result("busy", "Installing speech…");
  if (speech.engine === "missing")
    return result(
      "attention",
      speech.migrationRequired
        ? "Speech runtime update needed"
        : "Speech setup needed",
    );
  if (speech.engine === "error" || speech.phase === "error")
    return result("attention", "Speech needs attention");
  if (shortcut && !shortcut.registered)
    return result("attention", "Shortcut unavailable — open Settings");
  if (update?.phase === "error") return result("attention", "Update failed");
  if (update?.phase === "downloaded")
    return result(
      "update",
      `Update ${update.version ?? ""} ready`.replace("  ", " "),
    );
  if (update?.phase === "available")
    return result(
      "update",
      `Update ${update.version ?? ""} available`.replace("  ", " "),
    );
  return result(
    "idle",
    `Ready${shortcut?.registered ? ` · ${shortcut.accelerator}` : ""}`,
  );
}

/** One-line preview of a transcript for a menu label. */
export function menuPreview(text: string, length = 40): string {
  const line = text.replace(/\s+/g, " ").trim();
  // Menu labels treat "&" as a mnemonic marker on Windows and Linux.
  const safe = line.replace(/&/g, "&&");
  return safe.length > length
    ? `${safe.slice(0, length - 1).trimEnd()}…`
    : safe;
}
