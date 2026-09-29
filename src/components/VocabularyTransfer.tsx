import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Modal } from "./ui";
import { MAX_VOCABULARY_FILE_BYTES, parseVocabularyBundle, planVocabularyImport, serializeVocabularyBundle, vocabularyConflicts, type ImportChoice } from "../vocabularyTransfer";
import { ruleKind } from "../personalization";
import type { CustomWord } from "../types";

export function VocabularyTransfer({ words, saving, onChange }: {
  words: CustomWord[];
  saving: boolean;
  onChange: (words: CustomWord[]) => Promise<boolean>;
}) {
  const file = useRef<HTMLInputElement>(null);
  const readGeneration = useRef(0);
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [incoming, setIncoming] = useState<CustomWord[] | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportChoice | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const busy = reading || submitting || saving;
  const close = () => {
    readGeneration.current++;
    setOpen(false);
    setRaw("");
    setIncoming(null);
    setError(null);
    setReading(false);
  };
  let plan: ReturnType<typeof planVocabularyImport> | null = null;
  let planError: string | null = null;
  if (incoming) {
    try { plan = planVocabularyImport(incoming, words, choices); }
    catch (reason) { planError = reason instanceof Error ? reason.message : "Review the import choices."; }
  }
  const review = () => {
    try {
      const bundle = parseVocabularyBundle(raw);
      setIncoming(bundle.rules);
      setChoices(Object.fromEntries(bundle.rules.map((rule) => [rule.id, vocabularyConflicts(rule, words).length ? undefined : "add"])));
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not read the rules file."); }
  };
  const exportRules = () => {
    try {
      const url = URL.createObjectURL(new Blob([serializeVocabularyBundle(words)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "delulu-personalization.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not export rules."); }
  };
  return <>
    <div className="flex gap-2 flex-wrap">
      <button className="secondary-button" disabled={busy} onClick={exportRules}><Download /> Export rules</button>
      <button className="secondary-button" disabled={busy} onClick={() => { setError(null); setOpen(true); }}><Upload /> Import rules</button>
    </div>
    {!open && error && <p className="field-error break-words" role="alert">{error}</p>}
    {open && <Modal title={incoming ? "Review imported rules" : "Import personalization rules"} onClose={close} busy={submitting || saving} footer={<>
      <button className="secondary-button" disabled={submitting || saving} onClick={close}>Cancel</button>
      {incoming ? <button className="primary-button" disabled={busy || !plan?.added} onClick={async () => {
        setSubmitting(true);
        try {
          const reviewed = planVocabularyImport(incoming, words, choices);
          if (await onChange(reviewed.words)) close();
          else setError("The rules could not be saved. Your reviewed import is still here; retry when the write problem is resolved.");
        } catch (reason) { setError(reason instanceof Error ? reason.message : "The import could not be saved."); }
        finally { setSubmitting(false); }
      }}>Import {plan?.added ?? 0} rules</button> : <button className="primary-button" disabled={busy || !raw.trim()} onClick={review}>Review import</button>}
    </>}>
      <p className="text-muted text-[12px] mb-3">Only vocabulary and text shortcuts are transferred. Transcripts, models and other settings are excluded. Nothing changes until you confirm the reviewed import.</p>
      {!incoming ? <>
        <input ref={file} type="file" accept=".json,application/json" aria-label="Choose rules JSON file" disabled={busy} onChange={async (event) => {
          const selected = event.target.files?.[0];
          if (!selected) return;
          const generation = ++readGeneration.current;
          setReading(true);
          setError(null);
          setRaw("");
          try {
            if (selected.size > MAX_VOCABULARY_FILE_BYTES) throw new Error("The rules file exceeds the 32 MiB limit.");
            const contents = await selected.text();
            if (generation === readGeneration.current) setRaw(contents);
          } catch (reason) { if (generation === readGeneration.current) setError(reason instanceof Error ? reason.message : "Could not read this file."); }
          finally { if (generation === readGeneration.current) setReading(false); }
        }} />
        <label className="field mt-3">Rules JSON<textarea aria-label="Rules JSON" value={raw} disabled={busy} onChange={(event) => { setRaw(event.target.value); setError(null); }} placeholder={'{"schemaVersion":1,"rules":[]}'} /></label>
        <p className="caption">Version 1 · up to 500 rules · file limit 32 MiB</p>
      </> : <>
        <p className="caption">{incoming.length} incoming rules. Conflicting rules need an explicit choice. Disabled rules reserve their phrases too.</p>
        <div className="content-stack mt-3">
          {incoming.map((rule) => {
            const conflicts = vocabularyConflicts(rule, words);
            return <article key={rule.id} className="border border-line rounded-lg p-3">
              <strong className="break-words">{rule.term}</strong> <span className="badge">{ruleKind(rule) === "shortcut" ? "Text shortcut" : "Correction"}{rule.enabled ? "" : " · Disabled"}</span>
              <p className="text-muted text-[12px] break-words mt-2">Aliases: {rule.soundsLike || "None"}</p>
              {rule.replacement && <pre className="whitespace-pre-wrap break-words text-[12px] mt-2">{rule.replacement}</pre>}
              {conflicts.length > 0 && <p className="text-[12px] break-words mt-2">Conflicts with existing: {conflicts.map((word) => `“${word.term}” (${ruleKind(word)})`).join(", ")}. Replace removes these listed rules.</p>}
              <label className="field mt-2">Action for {rule.term}<select aria-label={`Import action for ${rule.term}`} disabled={busy} value={choices[rule.id] ?? ""} onChange={(event) => { setChoices({ ...choices, [rule.id]: event.target.value as ImportChoice }); setError(null); }}>
                <option value="" disabled>Choose an action</option>
                {!conflicts.length && <option value="add">Add</option>}
                {conflicts.length > 0 && <option value="replace">Replace listed existing rules</option>}
                <option value="skip">Skip</option>
              </select></label>
            </article>;
          })}
        </div>
        {plan && <p className="text-[12px] mt-3">Import {plan.added}; replace {plan.replaced} existing; skip {plan.skipped}. Total after import: {plan.words.length}.</p>}
        {planError && <p className="field-error break-words mt-3" role="alert">{planError}</p>}
        <button className="secondary-button mt-3" disabled={busy} onClick={() => { setIncoming(null); setError(null); }}>Choose another file</button>
      </>}
      {error && <p className="field-error break-words mt-3" role="alert">{error}</p>}
    </Modal>}
  </>;
}
