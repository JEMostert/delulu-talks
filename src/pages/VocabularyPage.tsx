import { CircleHelp, Plus, Search, Sparkles, Trash2, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { CustomWord } from "../types";

function newId() { return `word-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function VocabularyPage({ words, saving, onChange }: { words: CustomWord[]; saving: boolean; onChange: (words: CustomWord[]) => void }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState({ term: "", soundsLike: "", replacement: "" });
  const filtered = useMemo(() => words.filter((word) => `${word.term} ${word.soundsLike} ${word.replacement}`.toLowerCase().includes(query.toLowerCase())), [query, words]);

  function addWord() {
    const term = draft.term.trim();
    if (!term) return;
    onChange([{ id: newId(), term, soundsLike: draft.soundsLike.trim(), replacement: draft.replacement.trim(), enabled: true }, ...words]);
    setDraft({ term: "", soundsLike: "", replacement: "" });
  }

  return (
    <div className="content-stack vocabulary-page">
      <section className="view-toolbar"><div><strong>Persistent correction rules</strong><span>Apply exact spelling, spoken aliases, and reusable text across every recording and restart.</span></div></section>

      <section className="word-composer">
        <div className="composer-heading"><span>NEW RULE</span><div><h3>Add a custom word</h3><p>Give us the right spelling and optionally what the model tends to hear.</p></div></div>
        <div className="composer-grid">
          <label><span>Correct word <b>Required</b></span><input aria-label="Correct word" value={draft.term} onChange={(event) => setDraft({ ...draft, term: event.target.value })} placeholder="e.g. Delulu" /></label>
          <label><span>Sounds like <small>comma separated</small></span><input aria-label="Spoken aliases" value={draft.soundsLike} onChange={(event) => setDraft({ ...draft, soundsLike: event.target.value })} placeholder="de loo loo, the lulu" /></label>
          <label><span>Expand to <small>optional</small></span><input aria-label="Expanded output" value={draft.replacement} onChange={(event) => setDraft({ ...draft, replacement: event.target.value })} placeholder="e.g. Delulu Talks™" /></label>
          <button className="primary-button" disabled={!draft.term.trim() || saving} onClick={addWord}><Plus /> Add word</button>
        </div>
        <div className="composer-tip"><Sparkles /> Say “de loo loo” and the final transcript will contain “Delulu”. Use “expand to” for voice snippets and boilerplate.</div>
      </section>

      <section className="word-list">
        <div className="section-heading"><div><p className="eyebrow">WORD BANK</p><h3>{words.length} custom {words.length === 1 ? "word" : "words"}</h3></div><label className="search-box"><Search /><input aria-label="Search Wordbook" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search words" /></label></div>
        <div className="word-table">
          <div className="word-row table-head"><span>Word</span><span>Recognition hint</span><span>Final output</span><span>Status</span><span /></div>
          {filtered.map((word) => (
            <div className="word-row" key={word.id}>
              <span className="word-name"><i>{word.term.slice(0, 1).toUpperCase()}</i><strong>{word.term}</strong></span>
              <span>{word.soundsLike || <em>No aliases</em>}</span><span>{word.replacement || word.term}</span>
              <button className={`toggle ${word.enabled ? "on" : ""}`} role="switch" aria-checked={word.enabled} aria-label={`Enable ${word.term}`} onClick={() => onChange(words.map((item) => item.id === word.id ? { ...item, enabled: !item.enabled } : item))}><i /></button>
              <button className="icon-button danger" aria-label={`Delete ${word.term}`} onClick={() => onChange(words.filter((item) => item.id !== word.id))}><Trash2 /></button>
            </div>
          ))}
          {!filtered.length && <div className="empty-state"><Volume2 /><h3>{words.length ? "No matching words" : "No custom words yet"}</h3><p>{words.length ? "Try a different search." : "Add the names and phrases you never want a speech model to butcher again."}</p></div>}
        </div>
      </section>

      <div className="info-banner"><CircleHelp /><div><strong>Model context is not persistent memory</strong><p>CrisperWhisper remembers recent words only while continuing one long recording. Native hotword boosting is exclusive to commercially licensed Pro weights, so the standard-model Wordbook uses exact whole-phrase rules that remain predictable across sessions.</p></div></div>
    </div>
  );
}
