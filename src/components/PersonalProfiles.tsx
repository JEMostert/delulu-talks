import { useRef, useState } from "react";
import { LANGUAGES } from "../data";
import { readPersonalProfiles, type PersonalProfileV1 } from "../personalProfiles";
import {
  PROFILE_STARTERS,
  profileForStarter,
  type PersonalProfileCommand,
  type ProfileStarterId,
} from "../personalProfileCommands";
import type { AppSettings } from "../types";
import { Modal } from "./ui";

function ProfileSummary({ profile }: { profile: PersonalProfileV1 }) {
  const language = LANGUAGES.find(([code]) => code === profile.language)?.[1] ?? profile.language;
  return (
    <p className="text-[12px] text-muted leading-relaxed">
      {language} · {profile.delivery.autoPaste ? "automatic paste requested" : "automatic paste off"}
      {" · "}{profile.delivery.copyToClipboard ? "copy on" : "copy off"}
      {" · "}{profile.delivery.keepHistory ? "history on" : "history off"}
      {" · "}{profile.vocabulary.rules.length} vocabulary rules
      {" · "}{profile.rewrite.enabled ? `optional rewrite: ${profile.rewrite.preset}` : "rewriting off"}
      {" · "}{profile.decode.mode === "backend-default" ? "backend decoding defaults" : "custom decode request (not applied)"}
      {" · "}{profile.context.mode === "none" ? "no context" : `${profile.context.mode} context request (not captured)`}
    </p>
  );
}

export function PersonalProfiles({ settings, saving, onManage }: {
  settings: AppSettings;
  saving: boolean;
  onManage: (command: PersonalProfileCommand) => Promise<boolean>;
}) {
  const [starter, setStarter] = useState<ProfileStarterId>("current");
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [remove, setRemove] = useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const busy = saving || pending;
  let profiles: PersonalProfileV1[] = [];
  let blocked: string | null = null;
  try {
    const result = readPersonalProfiles(settings.personalProfiles);
    if (result.status === "supported") profiles = result.document.profiles;
    else blocked = "These profiles were saved by a newer app version. They are preserved and read-only here. Use a compatible app version to manage them.";
  } catch (reason) {
    blocked = reason instanceof Error ? reason.message : String(reason);
  }
  const selected = PROFILE_STARTERS.find((item) => item.id === starter)!;
  let preview: PersonalProfileV1 | null = null;
  let previewError: string | null = null;
  try {
    preview = profileForStarter(settings, starter, "preview", name.trim() || selected.name);
  } catch (reason) {
    previewError = reason instanceof Error ? reason.message : String(reason);
  }
  async function run(command: PersonalProfileCommand, done: () => void) {
    if (pendingRef.current || saving || blocked) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (await onManage(command)) done();
      else setError("The profile change could not be saved. Check the error message and try again; your draft is retained.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <section className="settings-group">
      <div className="group-heading">
        <h3>Personal profiles</h3>
        <p>Save named settings for a workflow. Saving, renaming or deleting a profile does not change active settings. Profile activation is not available yet.</p>
      </div>
      {blocked ? <p role="alert" className="control-warning">{blocked}</p> : (
        <>
          <form className="grid gap-3 p-4" onSubmit={(event) => {
            event.preventDefault();
            void run({ action: "create", name, starter }, () => setName(""));
          }}>
            <label className="grid gap-1 text-[12px]">
              Start from
              <select value={starter} disabled={busy} onChange={(event) => {
                const next = PROFILE_STARTERS.find((item) => item.id === event.target.value)!;
                setStarter(next.id);
                if (!name.trim() || name === selected.name) setName(next.name);
              }}>
                {PROFILE_STARTERS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <p className="caption">{selected.description} All starters keep your vocabulary, use backend decoding defaults and request no context access.</p>
            <label className="grid gap-1 text-[12px]">
              Profile name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required disabled={busy} placeholder="e.g. Technical notes" />
            </label>
            {preview && <div className="rounded-lg border border-line p-3">
              <strong className="text-[12px]">Settings to save</strong>
              <ProfileSummary profile={preview} />
              <p className="caption mt-1">Identifier preservation requested; no literal terms added. Optional rewriting uses {preview.rewrite.model}. These settings are stored only.</p>
            </div>}
            {previewError && <p role="alert" className="control-warning">{previewError}</p>}
            <button className="secondary-button justify-self-start" type="submit" disabled={busy || !name.trim() || !!previewError || profiles.length >= 128}>
              {pending ? "Saving…" : "Save new profile"}
            </button>
            {profiles.length >= 128 && <p className="caption">128 profiles saved. Delete a profile before adding another.</p>}
          </form>
          <div className="grid gap-3 p-4 border-t border-line">
            <h4 className="text-[13px] font-semibold">Saved profiles ({profiles.length})</h4>
            {!profiles.length && <p className="caption">No profiles saved yet. Your existing settings remain active.</p>}
            {profiles.map((profile) => <article key={profile.id} className="rounded-lg border border-line p-3 grid gap-2">
              <strong className="text-[13px]">{profile.name}</strong>
              <ProfileSummary profile={profile} />
              <div className="flex gap-2">
                <button className="secondary-button" disabled={busy} onClick={() => { setError(null); setRename({ id: profile.id, name: profile.name }); }}>Rename</button>
                <button className="secondary-button" disabled={busy} onClick={() => { setError(null); setRemove({ id: profile.id, name: profile.name }); }}>Delete</button>
              </div>
            </article>)}
          </div>
        </>
      )}
      {error && <p role="alert" className="control-warning">{error}</p>}
      {rename && <Modal title="Rename profile" busy={busy} onClose={() => setRename(null)}>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void run({ action: "rename", id: rename.id, name: rename.name }, () => setRename(null)); }}>
          <label className="grid gap-1">Profile name<input autoFocus required maxLength={128} disabled={busy} value={rename.name} onChange={(event) => setRename({ ...rename, name: event.target.value })} /></label>
          <button className="primary-button" type="submit" disabled={busy || !rename.name.trim()}>{pending ? "Saving…" : "Save name"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Modal>}
      {remove && <Modal title="Delete saved profile?" busy={busy} onClose={() => setRemove(null)}>
        <p>Delete “{remove.name}” from saved profiles? Active settings, vocabulary and transcripts remain unchanged.</p>
        <div className="flex gap-2 mt-4">
          <button className="secondary-button" disabled={busy} onClick={() => setRemove(null)}>Keep profile</button>
          <button className="danger-button" disabled={busy} onClick={() => void run({ action: "delete", id: remove.id }, () => setRemove(null))}>{pending ? "Deleting…" : "Delete profile"}</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </Modal>}
    </section>
  );
}
