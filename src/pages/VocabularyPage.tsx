import { useState } from "react";
import { BookOpenText, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ConfirmDialog, EmptyState, Modal, Toggle } from "../components/ui";
import {
  personalize,
  ruleConflict,
  ruleKind,
  ruleTriggers,
} from "../personalization";
import type { CustomWord } from "../types";

export function VocabularyPage({
  words,
  saving,
  onChange,
}: {
  words: CustomWord[];
  saving: boolean;
  onChange: (words: CustomWord[]) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"correction" | "shortcut">("correction");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CustomWord | null>(null);
  const [remove, setRemove] = useState<CustomWord | null>(null);
  const [sample, setSample] = useState("");
  const filtered = words.filter(
    (word) =>
      ruleKind(word) === kind &&
      `${word.term} ${word.soundsLike} ${word.replacement}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const conflict = draft ? ruleConflict(draft, words) : null;
  const shortcut = draft && ruleKind(draft) === "shortcut";
  const invalid =
    !draft?.term.trim() ||
    (shortcut
      ? !draft.replacement.trim()
      : !draft.soundsLike.trim() ||
        draft.soundsLike.trim() === draft.term.trim());
  return (
    <div className="content-stack">
      <div
        className="page-tabs"
        role="tablist"
        aria-label="Personalization rules"
      >
        <button
          role="tab"
          aria-selected={kind === "correction"}
          className={kind === "correction" ? "active" : ""}
          onClick={() => setKind("correction")}
        >
          Corrections
        </button>
        <button
          role="tab"
          aria-selected={kind === "shortcut"}
          className={kind === "shortcut" ? "active" : ""}
          onClick={() => setKind("shortcut")}
        >
          Text shortcuts
        </button>
      </div>
      <section className="wordbook-intro">
        <div>
          <h2>
            {kind === "correction"
              ? "Fix recurring recognition mistakes"
              : "Insert saved text by voice"}
          </h2>
          <p>
            {kind === "correction"
              ? "Replace recognized phrases in clean results. You can also remember a correction directly from a transcript."
              : "Say a trigger phrase to insert an exact address, signature, or reusable block of text."}
          </p>
        </div>
        <button
          className="primary-button"
          disabled={saving || words.length >= 500}
          onClick={() => {
            setSample("");
            setDraft({
              id: crypto.randomUUID(),
              kind,
              term: "",
              soundsLike: "",
              replacement: "",
              enabled: true,
            });
          }}
        >
          <Plus />
          {kind === "correction" ? "Add correction" : "Add shortcut"}
        </button>
      </section>
      <div className="history-toolbar">
        <label className="search-box">
          <Search />
          <input
            aria-label="Search rules"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search phrases and replacements…"
          />
        </label>
        <span className="caption">{words.length} / 500 rules</span>
      </div>
      <section className="word-list">
        {filtered.map((word) => (
          <article className="word-item" key={word.id}>
            <span className="word-avatar">
              {ruleKind(word) === "shortcut" ? "↳" : "Aa"}
            </span>
            <div>
              <h3>
                {word.term}
                {!ruleTriggers(word).length && (
                  <span className="badge">Needs a correction phrase</span>
                )}
              </h3>
              <p>
                {ruleKind(word) === "shortcut"
                  ? `Say “${word.term}”`
                  : word.soundsLike
                    ? `Replace “${word.soundsLike}”`
                    : "Add the text the recognizer gets wrong to activate this rule."}
              </p>
              {word.replacement && <blockquote>{word.replacement}</blockquote>}
            </div>
            <div className="panel-actions">
              <Toggle
                value={word.enabled}
                label={`Enable ${word.term}`}
                disabled={saving || !ruleTriggers(word).length}
                onChange={() =>
                  void onChange(
                    words.map((item) =>
                      item.id === word.id
                        ? { ...item, enabled: !item.enabled }
                        : item,
                    ),
                  )
                }
              />
              <button
                className="icon-button"
                aria-label={`Edit ${word.term}`}
                disabled={saving}
                onClick={() => {
                  setDraft({ ...word, kind: ruleKind(word) });
                  setSample("");
                }}
              >
                <Pencil />
              </button>
              <button
                className="icon-button"
                aria-label={`Delete ${word.term}`}
                disabled={saving}
                onClick={() => setRemove(word)}
              >
                <Trash2 />
              </button>
            </div>
          </article>
        ))}
        {!filtered.length && (
          <EmptyState
            icon={BookOpenText}
            title={
              query
                ? "No matching rules"
                : kind === "correction"
                  ? "No corrections yet"
                  : "No text shortcuts yet"
            }
          >
            {query
              ? "Try a different search."
              : kind === "correction"
                ? "Correct a transcript and remember the change, or add a rule here."
                : "Add a trigger such as “my signature” and the exact text to insert."}
          </EmptyState>
        )}
      </section>
      <p className="privacy-footnote">
        Rules apply to clean output. Original speech and word timings stay
        untouched. These rules do not train the speech model.
      </p>
      {draft && (
        <Modal
          title={
            words.some((word) => word.id === draft.id)
              ? "Edit rule"
              : shortcut
                ? "New text shortcut"
                : "New correction"
          }
          onClose={() => setDraft(null)}
          busy={saving}
          footer={
            <>
              <button
                className="secondary-button"
                disabled={saving}
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={saving || !!invalid || !!conflict}
                onClick={async () => {
                  const normalized = {
                    ...draft,
                    term: draft.term.trim(),
                    soundsLike: draft.soundsLike.trim(),
                    replacement: draft.replacement.trim(),
                  };
                  if (
                    await onChange(
                      words.some((word) => word.id === draft.id)
                        ? words.map((word) =>
                            word.id === draft.id ? normalized : word,
                          )
                        : [normalized, ...words],
                    )
                  )
                    setDraft(null);
                }}
              >
                Save rule
              </button>
            </>
          }
        >
          {!shortcut && (
            <label className="field">
              Recognized text{" "}
              <small>Separate alternative mistakes with commas</small>
              <input
                autoFocus
                aria-label="Recognized text"
                maxLength={1024}
                value={draft.soundsLike}
                onChange={(e) =>
                  setDraft({ ...draft, soundsLike: e.target.value })
                }
                placeholder="the lulu, de loo loo"
              />
            </label>
          )}
          <label className="field">
            {shortcut ? "Trigger phrase" : "Replace with"}
            <input
              autoFocus={!!shortcut}
              aria-label={shortcut ? "Trigger phrase" : "Replace with"}
              maxLength={256}
              value={draft.term}
              onChange={(e) => setDraft({ ...draft, term: e.target.value })}
              placeholder={shortcut ? "my signature" : "Delulu"}
            />
          </label>
          {shortcut && (
            <>
              <label className="field">
                Exact text to insert
                <textarea
                  aria-label="Expanded output"
                  maxLength={4096}
                  value={draft.replacement}
                  onChange={(e) =>
                    setDraft({ ...draft, replacement: e.target.value })
                  }
                  placeholder="Your reusable text…"
                />
              </label>
              <label className="field">
                Alternative triggers <small>Optional · comma-separated</small>
                <input
                  aria-label="Alternative triggers"
                  value={draft.soundsLike}
                  maxLength={1024}
                  onChange={(e) =>
                    setDraft({ ...draft, soundsLike: e.target.value })
                  }
                />
              </label>
            </>
          )}
          {conflict && (
            <p className="field-error" role="alert">
              {conflict}
            </p>
          )}
          <div className="rule-test">
            <label className="field">
              Try this rule
              <input
                aria-label="Test phrase"
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder={
                  shortcut
                    ? `Please insert ${draft.term || "my signature"}`
                    : draft.soundsLike.split(",")[0] ||
                      "Type a recognized phrase"
                }
              />
            </label>
            <output aria-label="Rule preview">
              {sample
                ? personalize(sample, [{ ...draft, enabled: true }])
                : "Enter a phrase to preview the exact replacement."}
            </output>
          </div>
        </Modal>
      )}
      {remove && (
        <ConfirmDialog
          title={`Delete “${remove.term}”?`}
          confirmLabel="Delete rule"
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void onChange(words.filter((word) => word.id !== remove.id))
          }
        >
          <p>
            Future clean results will no longer use this rule. Saved transcripts
            stay unchanged.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
