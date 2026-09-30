import { useRef, useState } from "react";
import {
  activeProfileLabel,
  effectiveProfileSettings,
  profileActivationSettings,
  type CaptureProfileSnapshot,
  type ProfileActivationCommand,
  type ProfileEffectiveSettings,
} from "../activePersonalProfile";
import { readPersonalProfiles } from "../personalProfiles";
import type { AppSettings } from "../types";
import { Modal } from "./ui";

function settingRows(value: ProfileEffectiveSettings): [string, string][] {
  return [
    ["Language", value.language],
    ["Automatic paste", value.autoPaste ? "On" : "Off"],
    ["Copy to clipboard", value.copyToClipboard ? "On" : "Off"],
    ["Save history", value.keepHistory ? "On" : "Off"],
    [
      "Vocabulary",
      `${value.customWords.length} rules (${value.customWords.filter((word) => word.enabled).length} enabled)`,
    ],
    [
      "Automatic rewriting",
      value.magicEnabled ? `On · ${value.magicModel}` : "Off",
    ],
    ["Rewrite preset", value.magicPreset],
    ["Rewrite inferences", value.magicAllowInferences ? "Allowed" : "Off"],
  ];
}
export function ProfileActivationControls({
  settings,
  busy,
  onActivate,
  captureProfile,
}: {
  settings: AppSettings;
  busy: boolean;
  onActivate: (command: ProfileActivationCommand) => Promise<boolean>;
  captureProfile?: CaptureProfileSnapshot | null;
}) {
  const [choice, setChoice] = useState("global");
  const [preview, setPreview] = useState<{
    name: string;
    command: ProfileActivationCommand;
    before: ProfileEffectiveSettings;
    after: ProfileEffectiveSettings;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const result = readPersonalProfiles(settings.personalProfiles);
  const profiles =
    result.status === "supported" ? result.document.profiles : [];
  const label = captureProfile?.label ?? activeProfileLabel(settings);
  const disabled = busy || pending;
  function openPreview() {
    setError(null);
    const before = effectiveProfileSettings(settings);
    if (choice === "global") {
      if (!settings.activePersonalProfile) return;
      setPreview({
        name: "Global settings",
        before,
        after: settings.activePersonalProfile.globalSettings,
        command: { action: "global", expectedCurrentSettings: before },
      });
      return;
    }
    const selected = profiles.find((profile) => profile.id === choice);
    if (!selected) {
      setError("This saved profile is no longer available.");
      return;
    }
    try {
      setPreview({
        name: selected.name,
        before,
        after: profileActivationSettings(selected),
        command: {
          action: "activate",
          id: selected.id,
          expectedProfile: structuredClone(selected),
          expectedCurrentSettings: before,
        },
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function confirm() {
    if (!preview || disabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (await onActivate(preview.command)) setPreview(null);
      else
        setError(
          "The switch was not applied. Check the error message; reopen the preview if settings or profiles changed.",
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <div className="grid gap-2 px-3.5 py-2.5 border-t border-line">
      <p className="text-[12px]" title={label}>
        {captureProfile ? "Capture profile" : "Active profile"}:{" "}
        <strong>{label}</strong>
      </p>
      <div className="flex flex-wrap gap-2">
        <label className="text-[11px] text-muted flex items-center gap-2">
          Switch to
          <select
            aria-label="Profile to activate"
            value={choice}
            disabled={disabled}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="global">Global settings</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button text-[11px]"
          disabled={
            disabled || (choice === "global" && !settings.activePersonalProfile)
          }
          onClick={openPreview}
        >
          Preview switch
        </button>
      </div>
      {result.status === "unsupported" && (
        <p className="caption">
          Saved profiles use a newer schema and cannot be activated here.
        </p>
      )}

      {error && (
        <p role="alert" className="control-warning">
          {error}
        </p>
      )}
      {preview && (
        <Modal
          title={`Activate ${preview.name}?`}
          busy={disabled}
          onClose={() => setPreview(null)}
        >
          <p className="caption">
            This changes future captures. Original transcripts remain unchanged.
            Switch only while recording and model operations are idle.
          </p>
          <table className="w-full text-[12px] my-3">
            <thead>
              <tr>
                <th className="text-left">Setting</th>
                <th className="text-left">Current</th>
                <th className="text-left">After switch</th>
              </tr>
            </thead>
            <tbody>
              {settingRows(preview.before).map(([key, value], index) => (
                <tr key={key}>
                  <td className="py-1">{key}</td>
                  <td>{value}</td>
                  <td>{settingRows(preview.after)[index][1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="text-[12px] mb-3">
            <summary>Vocabulary to apply</summary>
            {[
              ["Current rules", preview.before.customWords],
              ["After switch", preview.after.customWords],
            ].map(([title, rules]) => (
              <div key={String(title)} className="mt-2">
                <strong>{String(title)}</strong>
                {(rules as AppSettings["customWords"]).length === 0 && (
                  <p>No rules</p>
                )}
                {(rules as AppSettings["customWords"]).map((word) => (
                  <div key={word.id} className="border border-line p-2 my-1">
                    <p>
                      {word.enabled ? "Enabled" : "Disabled"} ·{" "}
                      {word.kind ?? "correction"} · {word.term}
                      {word.soundsLike ? ` (heard as ${word.soundsLike})` : ""}
                    </p>
                    {word.replacement && (
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap wrap-anywhere">
                        {word.replacement}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </details>
          <p className="caption">
            Backend decoding defaults; built-in protection for explicit
            technical identifiers and saved blocks; no context capture. Optional
            rewriting remains a separate engine. Global settings restores the
            snapshot taken before the first profile activation.
          </p>
          {error && (
            <p role="alert" className="control-warning">
              {error}
            </p>
          )}
          <div className="flex gap-2 mt-4">
            <button
              className="secondary-button"
              disabled={disabled}
              onClick={() => setPreview(null)}
            >
              Keep current settings
            </button>
            <button
              className="primary-button"
              disabled={disabled}
              onClick={() => void confirm()}
            >
              {pending ? "Switching…" : "Apply these settings"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
