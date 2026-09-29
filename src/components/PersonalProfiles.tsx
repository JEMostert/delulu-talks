import { useEffect, useRef, useState } from "react";
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

function EffectiveProfileSettings({ profile, settings }: { profile: PersonalProfileV1; settings: AppSettings }) {
  const languageName = (code: string) => LANGUAGES.find(([value]) => value === code)?.[1] ?? code;
  const yesNo = (value: boolean) => value ? "On" : "Off";
  const saved: [string, string, string][] = [
    ["Recognition language", languageName(profile.language), languageName(settings.language)],
    ["Automatic paste", yesNo(profile.delivery.autoPaste), yesNo(settings.autoPaste)],
    ["Copy to clipboard", yesNo(profile.delivery.copyToClipboard), yesNo(settings.copyToClipboard)],
    ["Keep history", yesNo(profile.delivery.keepHistory), yesNo(settings.keepHistory)],
    ["Vocabulary", `${profile.vocabulary.rules.length} saved rules`, `${settings.customWords.length} current rules`],
    ["Optional rewriting", yesNo(profile.rewrite.enabled), yesNo(settings.magicEnabled)],
    ["Rewrite model", profile.rewrite.model, settings.magicModel],
    ["Rewrite preset", profile.rewrite.preset, settings.magicPreset],
    ["Allow rewrite inferences", yesNo(profile.rewrite.allowInferences), yesNo(settings.magicAllowInferences)],
  ];
  const inherited: [string, string][] = [
    ["Microphone", settings.inputDeviceLabel || (settings.inputDeviceId === "default" ? "System default" : settings.inputDeviceId)],
    ["Shortcut", `${settings.shortcut} · ${settings.shortcutMode}`],
    ["Speech backend", settings.model],
    ["Recording indicator", yesNo(settings.showOverlay)],
    ["Keep speech loaded", yesNo(settings.preloadModel)],
    ["Keep rewriting loaded", yesNo(settings.preloadMagicModel)],
    ["Model idle timeout", settings.modelIdleMinutes ? `${settings.modelIdleMinutes} minutes` : "Disabled"],
    ["Python command", settings.pythonCommand || "Automatic discovery"],
  ];
  return <details className="mt-2">
    <summary className="text-[12px] cursor-pointer">Effective settings and global defaults</summary>
    <p className="caption mt-2">Profile values are saved snapshots, including values matching today's defaults. Global values below remain shared and follow later global changes. Native paste permissions remain global; requesting paste does not grant permission.</p>
    <div className="overflow-x-auto mt-2">
      <table className="w-full text-left text-[12px]">
        <caption className="text-left caption mb-2">Requested configuration for this profile; saving does not activate it.</caption>
        <thead><tr><th className="p-2">Setting</th><th className="p-2">Profile value</th><th className="p-2">Current global default</th><th className="p-2">Source</th></tr></thead>
        <tbody>
          {saved.map(([label, value, global]) => <tr key={label} className="border-t border-line"><th scope="row" className="p-2 font-normal">{label}</th><td className="p-2 break-words">{value}</td><td className="p-2 break-words">{global}</td><td className="p-2">Saved profile snapshot</td></tr>)}
          {inherited.map(([label, value]) => <tr key={label} className="border-t border-line"><th scope="row" className="p-2 font-normal">{label}</th><td className="p-2 break-words">{value}</td><td className="p-2 break-words">{value}</td><td className="p-2">Inherited from global settings</td></tr>)}
          <tr className="border-t border-line"><th scope="row" className="p-2 font-normal">Decoding</th><td colSpan={2} className="p-2">{profile.decode.mode === "backend-default" ? "Backend defaults; not overridden by profile" : `Requested temperature ${profile.decode.temperature}, token budget ${profile.decode.maxTokens}; not applied by this profile manager`}</td><td className="p-2">{profile.decode.mode === "backend-default" ? "Backend" : "Saved request"}</td></tr>
          <tr className="border-t border-line"><th scope="row" className="p-2 font-normal">Context access</th><td colSpan={2} className="p-2">{profile.context.mode === "none" ? "None requested" : `${profile.context.mode} requested; not captured by this profile manager`}</td><td className="p-2">Saved request; permissions separate</td></tr>
        </tbody>
      </table>
    </div>
  </details>;
}

export function PersonalProfiles({ settings, saving, onManage }: {
  settings: AppSettings;
  saving: boolean;
  onManage: (command: PersonalProfileCommand) => Promise<boolean>;
}) {
  const [includeVocabulary, setIncludeVocabulary] = useState(false);
  const [importDocument, setImportDocument] = useState<import("../personalProfiles").PersonalProfileDocument | null>(null);
  const [importNames, setImportNames] = useState<string[]>([]);
  const fileRevision = useRef(0);
  useEffect(() => () => { fileRevision.current += 1; }, []);
  const [starter, setStarter] = useState<ProfileStarterId>("current");
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
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
  function exportProfiles() {
    const document = { schemaVersion: 1, profiles: structuredClone(profiles) };
    if (!includeVocabulary) for (const profile of document.profiles) profile.vocabulary.rules = [];
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2) + "\n"], { type: "application/json" }));
    const link = documentElement(url);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function documentElement(url: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = `delulu-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    return link;
  }
  return (
    <section className="settings-group">
      <div className="group-heading">
        <h3>Personal profiles</h3>
        <p>Save named settings for a workflow. Saving, renaming or deleting a profile does not change active settings. Profile activation is not available yet.</p>
      </div>
      {blocked ? <p role="alert" className="control-warning">{blocked}</p> : (
        <>
          <div className="grid gap-3 p-4 border-b border-line">
            <h4 className="text-[13px] font-semibold">Transfer profiles</h4>
            <label className="flex gap-2 text-[12px]"><input type="checkbox" checked={includeVocabulary} disabled={busy} onChange={(event) => setIncludeVocabulary(event.target.checked)} />Include personal vocabulary in export/import</label>
            <p className="caption">Exports contain saved profile settings and enabled context requests, including any manual context and rewrite instructions. Review the JSON before sharing. Global settings, permissions, transcripts and active identity are excluded. Import creates new saved profiles and does not activate them.</p>
            <button className="secondary-button justify-self-start" disabled={busy || !profiles.length} onClick={exportProfiles}>Export saved profiles</button>
            <label className="grid gap-1 text-[12px]">Import JSON file
              <input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                const revision = ++fileRevision.current;
                setImportDocument(null); setImportNames([]); setError(null);
                if (!file) return;
                if (file.size > 5_000_000) { setError("Profile export exceeds the 5 MB limit."); return; }
                void file.text().then((text) => {
                  if (fileRevision.current !== revision) return;
                  const result = readPersonalProfiles(JSON.parse(text));
                  if (result.status !== "supported") throw new Error("This export needs a newer compatible app version.");
                  if (!result.document.profiles.length) throw new Error("This export contains no profiles.");
                  setImportDocument(result.document);
                  setImportNames(result.document.profiles.map((profile) => profile.name));
                }).catch((reason) => {
                  if (fileRevision.current === revision) setError(reason instanceof Error ? reason.message : String(reason));
                });
              }} />
            </label>
            {importDocument && <div className="grid gap-2">
              <p className="caption">Ready to import {importNames.length}: {importNames.join(", ")}. Vocabulary {includeVocabulary ? "included" : "excluded"}. Existing profiles are never replaced; conflicting names reject the entire import.</p>
              <button className="secondary-button justify-self-start" disabled={busy} onClick={() => void run({ action: "import", document: importDocument, includeVocabulary }, () => { setImportDocument(null); setImportNames([]); })}>Import as new profiles</button>
            </div>}
          </div>
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
              <EffectiveProfileSettings profile={preview} settings={settings} />
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
              <EffectiveProfileSettings profile={profile} settings={settings} />
              <div className="flex gap-2">
                <button className="secondary-button" disabled={busy} onClick={() => { setError(null); setRename({ id: profile.id, name: profile.name }); }}>Rename</button>
                <button className="secondary-button" disabled={busy || profiles.length >= 128} onClick={() => { setError(null); setDuplicate({ id: profile.id, name: `${profile.name} copy` }); }}>Duplicate</button>
                <button className="secondary-button" disabled={busy} onClick={() => { setError(null); setRemove({ id: profile.id, name: profile.name }); }}>Delete</button>
              </div>
            </article>)}
          </div>
        </>
      )}
      {error && <p role="alert" className="control-warning">{error}</p>}
      {rename && <Modal title="Rename profile" busy={busy} onClose={() => setRename(null)}>
        {profiles.find((profile) => profile.id === rename.id) && <EffectiveProfileSettings profile={profiles.find((profile) => profile.id === rename.id)!} settings={settings} />}
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void run({ action: "rename", id: rename.id, name: rename.name }, () => setRename(null)); }}>
          <label className="grid gap-1">Profile name<input autoFocus required maxLength={128} disabled={busy} value={rename.name} onChange={(event) => setRename({ ...rename, name: event.target.value })} /></label>
          <button className="primary-button" type="submit" disabled={busy || !rename.name.trim()}>{pending ? "Saving…" : "Save name"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Modal>}
      {duplicate && <Modal title="Duplicate profile" busy={busy} onClose={() => setDuplicate(null)}>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void run({ action: "duplicate", id: duplicate.id, name: duplicate.name }, () => setDuplicate(null)); }}>
          <p className="caption">Creates a separate saved profile with a new identity. Global shortcut bindings stay shared; duplication does not register another binding or activate the copy. Conflicting names and enabled vocabulary shortcuts reject the save.</p>
          <label className="grid gap-1">New profile name<input autoFocus required maxLength={128} disabled={busy} value={duplicate.name} onChange={(event) => setDuplicate({ ...duplicate, name: event.target.value })} /></label>
          <button className="primary-button" type="submit" disabled={busy || !duplicate.name.trim()}>{pending ? "Saving…" : "Save copy"}</button>
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
