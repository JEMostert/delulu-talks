import { useMemo, useState } from "react";
import { BookOpenText, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ConfirmDialog, EmptyState, Modal, Toggle } from "../components/ui";
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
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CustomWord | null>(null);
  const [remove, setRemove] = useState<CustomWord | null>(null);
  const filtered = useMemo(
    () =>
      words.filter((word) =>
        `${word.term} ${word.soundsLike} ${word.replacement}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [query, words],
  );
  const duplicate =
    draft &&
    words.some(
      (word) =>
        word.id !== draft.id &&
        word.term.toLowerCase() === draft.term.trim().toLowerCase(),
    );
  return (
    <div className="content-stack">
      <section className="wordbook-intro">
        <div>
          <h2>Corrections & snippets</h2>
          <p>
            Replace recognition mistakes and expand spoken phrases into saved
            text.
          </p>
        </div>
        <button
          className="primary-button"
          disabled={saving || words.length >= 500}
          onClick={() =>
            setDraft({
              id: crypto.randomUUID(),
              term: "",
              soundsLike: "",
              replacement: "",
              enabled: true,
            })
          }
        >
          <Plus /> Add a word
        </button>
      </section>
      <div className="history-toolbar">
        <label className="search-box">
          <Search />
          <input
            aria-label="Search Wordbook"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your words and snippets…"
          />
        </label>
        <span className="caption">{words.length} / 500 words</span>
      </div>
      <section className="word-list">
        {filtered.map((word) => (
          <article className="word-item" key={word.id}>
            <span className="word-avatar">{word.term[0].toUpperCase()}</span>
            <div>
              <h3>
                {word.term}
                {word.replacement && <span className="badge">Snippet</span>}
              </h3>
              <p>
                {word.soundsLike
                  ? `When you say “${word.soundsLike}”`
                  : "Uses this exact spelling"}
              </p>
              {word.replacement && <blockquote>{word.replacement}</blockquote>}
            </div>
            <div className="panel-actions">
              <Toggle
                value={word.enabled}
                label={`Enable ${word.term}`}
                disabled={saving}
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
                onClick={() => setDraft({ ...word })}
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
            title={words.length ? "No matching words" : "No saved words"}
          >
            {words.length
              ? "Try a different search."
              : "Add a name the model misses, or a phrase you say often."}
          </EmptyState>
        )}
      </section>
      <p className="privacy-footnote">
        Words apply as whole-phrase corrections after transcription. Use “Expand
        to” for reusable voice snippets.
      </p>
      {draft && (
        <Modal
          title={
            words.some((word) => word.id === draft.id)
              ? "Edit word"
              : "A new word to remember"
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
                disabled={saving || !draft.term.trim() || !!duplicate}
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
                Save word
              </button>
            </>
          }
        >
          <label className="field">
            Correct spelling
            <input
              autoFocus
              aria-label="Correct word"
              maxLength={256}
              value={draft.term}
              onChange={(e) => setDraft({ ...draft, term: e.target.value })}
              placeholder="Delulu"
            />
          </label>
          {duplicate && (
            <p className="field-error" role="alert">
              That word already exists. Edit the existing entry instead.
            </p>
          )}
          <label className="field">
            What it sounds like{" "}
            <small>Optional · separate aliases with commas</small>
            <input
              aria-label="Spoken aliases"
              maxLength={1024}
              value={draft.soundsLike}
              onChange={(e) =>
                setDraft({ ...draft, soundsLike: e.target.value })
              }
              placeholder="the lulu, de loo loo"
            />
          </label>
          <label className="field">
            Expand to{" "}
            <small>
              Optional · insert a longer phrase when you say this word
            </small>
            <textarea
              aria-label="Expanded output"
              maxLength={4096}
              value={draft.replacement}
              onChange={(e) =>
                setDraft({ ...draft, replacement: e.target.value })
              }
              placeholder="Your reusable text goes here…"
            />
          </label>
        </Modal>
      )}
      {remove && (
        <ConfirmDialog
          title={`Forget “${remove.term}”?`}
          confirmLabel="Delete word"
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void onChange(words.filter((word) => word.id !== remove.id))
          }
        >
          <p>Future transcripts will no longer use this rule.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
