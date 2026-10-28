import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { isTermList, restorePaste, serialQueue, termCount } from "../helpers";
import { CleanupControl } from "../components/CleanupControl";
import { IconButton, Row, Switch } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";

/**
 * Runs one vocabulary change and keeps the result; errors become a notice. Changes
 * run one at a time, so every reply is newer than the one before it.
 */
type Run = (
  call: () => Promise<ipc.Vocabulary>,
) => Promise<ipc.Vocabulary | undefined>;

export function Cleanup({ state }: { state: AppState }) {
  const { settings, update, cleanupStatus, setNotice } = state;
  const [vocabulary, setVocabulary] = useState<ipc.Vocabulary>();
  const [queue] = useState(() => serialQueue());
  useEffect(() => {
    let active = true;
    queue(ipc.getVocabulary)
      .then((value) => {
        if (active) setVocabulary(value);
      })
      .catch((e) => {
        if (active) setNotice(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [queue, setNotice]);
  const run = useCallback<Run>(
    async (call) => {
      try {
        const value = await queue(call);
        setVocabulary(value);
        return value;
      } catch (e) {
        setNotice(errorText(e));
        return undefined;
      }
    },
    [queue, setNotice],
  );
  const [openId, setOpenId] = useState<string>();
  if (!settings) return null;
  const shelves = vocabulary?.shelves ?? [];
  const open = shelves.find((shelf) => shelf.id === openId);
  return (
    <div className="cleanup">
      <div className="title-block">
        <h1>Cleanup</h1>
        <p className="lead">
          After each dictation, a small model on this computer tidies the text.
        </p>
      </div>
      <div className="group">
        <Row
          label="Clean up text"
          htmlFor="cleanup"
          help="Removes filler words and adds punctuation, on this computer. Dutch and English."
          stack
        >
          <Switch
            id="cleanup"
            checked={settings.cleanup}
            onChange={(value) => void update("cleanup", value)}
          />
          <CleanupControl
            status={cleanupStatus}
            onError={(e) => setNotice(errorText(e))}
          />
        </Row>
      </div>
      <section className="vocab" aria-labelledby="vocab-title">
        <div className="section-head">
          <h2 id="vocab-title">Vocabularies</h2>
          <p>Names and terms you say often.</p>
        </div>
        {!settings.cleanup && shelves.length > 0 && (
          <p className="vocab-note">
            Vocabularies are used while Clean up text is on.
          </p>
        )}
        {vocabulary && vocabulary.usedTerms < vocabulary.activeTerms && (
          <p className="vocab-note warn">
            <Icon name="alert" size={16} />
            Cleanup uses the first {vocabulary.usedTerms} of{" "}
            {vocabulary.activeTerms} terms. Turn off shelves you don’t need
            right now.
          </p>
        )}
        {vocabulary && shelves.length === 0 && (
          <p className="vocab-intro">
            Speech recognition sometimes mishears names and jargon. Put them in
            a jar, like “T3 Code” on a Programming shelf, and cleanup turns
            “ghthree code” back into “T3 Code”.
          </p>
        )}
        {vocabulary && (
          <div className="reef">
            {shelves.map((shelf) => (
              <div key={shelf.id} className="reef-slot">
                <Jar shelf={shelf} onOpen={() => setOpenId(shelf.id)} />
              </div>
            ))}
            <div className="reef-slot">
              <NewJar
                first={shelves.length === 0}
                onAdd={async (name) => {
                  const value = await run(() => ipc.addShelf(name));
                  const shelf = value?.shelves[value.shelves.length - 1];
                  if (shelf) {
                    setOpenId(shelf.id);
                  }
                  return value !== undefined;
                }}
              />
            </div>
          </div>
        )}
        {vocabulary && vocabulary.presets.length > 0 && (
          <div className="starters">
            <p className="starters-title">
              Starter shelves, ready to put on the reef
            </p>
            <div className="reef reef-ghost">
              {vocabulary.presets.map((preset) => (
                <div key={preset.key} className="reef-slot">
                  <button
                    type="button"
                    className="jar jar-ghost"
                    aria-label={`Add ${preset.name}, ${termCount(preset.terms.length)}`}
                    onClick={() =>
                      void run(() => ipc.addPresetShelf(preset.key))
                    }
                  >
                    <JarBody
                      name={preset.name}
                      words={preset.terms}
                      meta={termCount(preset.terms.length)}
                      badge="plus"
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      {open && (
        <ShelfDialog
          key={open.id}
          shelf={open}
          run={run}
          setNotice={setNotice}
          onClose={() => {
            setOpenId(undefined);
          }}
        />
      )}
    </div>
  );
}

/** A glass jar on the reef: its first words float inside, the name is on its tag. */
function JarBody({
  name,
  words,
  meta,
  badge,
}: {
  name: string;
  words: string[];
  meta: string;
  badge?: "plus";
}) {
  return (
    <>
      <span className="jar-lid" aria-hidden="true" />
      <span className="jar-glass" aria-hidden="true">
        <span className="jar-words">
          {words.slice(0, 4).map((word, i) => (
            <span key={`${word}-${i}`} className="jar-word">
              {word}
            </span>
          ))}
        </span>
        {badge && (
          <span className="jar-badge">
            <Icon name="plus" size={16} />
          </span>
        )}
      </span>
      <span className="jar-tag">
        <span className="jar-name">{name}</span>
        <span className="jar-meta">{meta}</span>
      </span>
    </>
  );
}

function Jar({ shelf, onOpen }: { shelf: ipc.Shelf; onOpen: () => void }) {
  const meta = shelf.enabled
    ? termCount(shelf.terms.length)
    : `Off · ${termCount(shelf.terms.length)}`;
  return (
    <button
      type="button"
      className={`jar ${shelf.enabled ? "" : "off"}`}
      aria-label={`Open ${shelf.name}, ${meta}`}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <JarBody name={shelf.name} words={shelf.terms} meta={meta} />
    </button>
  );
}

/** An empty jar outline: name it and press Enter to make a new shelf. */
function NewJar({
  first,
  onAdd,
}: {
  first: boolean;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="jar jar-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const submitted = name;
        void onAdd(submitted).then((ok) => {
          // Keep a name typed while the shelf was saving.
          if (ok) setName((now) => (now === submitted ? "" : now));
        });
      }}
    >
      <span className="jar-lid" aria-hidden="true" />
      <span className="jar-glass">
        <label className="visually-hidden" htmlFor="new-shelf">
          New shelf name
        </label>
        <input
          id="new-shelf"
          className="field"
          placeholder={first ? "Programming" : "New shelf"}
          maxLength={40}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          className="button primary"
          disabled={!name.trim()}
        >
          <Icon name="plus" size={16} />
          Add shelf
        </button>
      </span>
    </form>
  );
}

/** Everything on one shelf, in a glass panel over the reef. */
function ShelfDialog({
  shelf,
  run,
  setNotice,
  onClose,
}: {
  shelf: ipc.Shelf;
  run: Run;
  setNotice: (notice: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = `terms-${shelf.id}`;
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    // Open ready to add a word, not on the first button.
    field.current?.focus();
    return () => node?.close();
  }, []);
  async function add(text: string) {
    const value = await run(() => ipc.addTerms(shelf.id, text));
    if (!value) return false;
    const after = value.shelves.find((s) => s.id === shelf.id);
    if (after && after.terms.length === shelf.terms.length)
      setNotice(`Already on ${shelf.name}`);
    return true;
  }
  return (
    <dialog
      ref={dialog}
      className="vocab-dialog"
      aria-labelledby={`dialog-${shelf.id}`}
      onCancel={(e) => {
        // Escape: let a rename field handle it first.
        e.preventDefault();
        if (!renaming) onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          {renaming ? (
            <RenameField
              name={shelf.name}
              onSave={async (name) =>
                !name.trim() ||
                name.trim() === shelf.name ||
                (await run(() => ipc.renameShelf(shelf.id, name))) !== undefined
              }
              onClose={() => setRenaming(false)}
            />
          ) : (
            <h2 id={`dialog-${shelf.id}`} className="dialog-title">
              {shelf.name}
            </h2>
          )}
          {!renaming && (
            <IconButton
              icon="edit"
              label={`Rename ${shelf.name}`}
              onClick={() => setRenaming(true)}
            />
          )}
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="dialog-use">
          <Switch
            id={`shelf-${shelf.id}`}
            checked={shelf.enabled}
            onChange={(enabled) =>
              void run(() => ipc.setShelfEnabled(shelf.id, enabled))
            }
          />
          <label htmlFor={`shelf-${shelf.id}`}>
            {shelf.enabled
              ? "Cleanup listens for these words"
              : "Off: cleanup ignores this shelf"}
          </label>
          <span className="shelf-count">{termCount(shelf.terms.length)}</span>
        </div>
        {shelf.terms.length > 0 ? (
          <ul className="terms" aria-label={`Terms on ${shelf.name}`}>
            {shelf.terms.map((term) => (
              <li key={term} className="term">
                <span>{term}</span>
                <button
                  type="button"
                  aria-label={`Remove ${term}`}
                  title={`Remove ${term}`}
                  onClick={() => {
                    field.current?.focus();
                    void run(() => ipc.removeTerm(shelf.id, term));
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="terms-empty">
            An empty jar. Add the names and terms you say, like T3 Code.
          </p>
        )}
        <label className="visually-hidden" htmlFor={fieldId}>
          Add terms to {shelf.name}
        </label>
        <input
          id={fieldId}
          ref={field}
          className="field"
          placeholder="Add a term and press Enter. Paste a list to add several."
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !draft.trim()) return;
            e.preventDefault();
            const text = draft;
            void add(text).then((ok) => {
              // Keep anything typed while the change was saving.
              if (ok) setDraft((now) => (now === text ? "" : now));
            });
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!isTermList(text)) return;
            e.preventDefault();
            const input = e.currentTarget;
            const start = input.selectionStart ?? draft.length;
            const end = input.selectionEnd ?? start;
            const before = draft;
            void add(text).then((ok) => {
              // Not saved: put the list in the field so it can be fixed.
              if (!ok)
                setDraft((now) => restorePaste(now, before, start, end, text));
            });
          }}
        />
        {confirming ? (
          <div className="confirm" role="alert">
            <p>
              Delete {shelf.name} and its {termCount(shelf.terms.length)}?
            </p>
            <button
              type="button"
              className="button"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                onClose();
                void run(() => ipc.deleteShelf(shelf.id));
              }}
            >
              Delete
            </button>
          </div>
        ) : (
          <footer className="dialog-foot">
            <button
              type="button"
              className="button quiet danger-text"
              onClick={() => {
                if (shelf.terms.length) setConfirming(true);
                else {
                  onClose();
                  void run(() => ipc.deleteShelf(shelf.id));
                }
              }}
            >
              <Icon name="trash" size={16} />
              Delete shelf
            </button>
            <button type="button" className="button primary" onClick={onClose}>
              Done
            </button>
          </footer>
        )}
      </div>
    </dialog>
  );
}

/** Saves on Enter or blur; closes once the saved name is still the one shown. */
function RenameField({
  name,
  onSave,
  onClose,
}: {
  name: string;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  const latest = useRef(name);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  // Escape closes the field; the blur that may follow must not save.
  const cancelled = useRef(false);
  const done = () => {
    if (saving.current || cancelled.current) return;
    saving.current = true;
    const saved = latest.current;
    void onSave(saved).then((ok) => {
      saving.current = false;
      if (!ok || cancelled.current) return;
      if (latest.current === saved) onClose();
      // Edited while saving and left meanwhile: that blur was skipped, save again.
      else if (document.activeElement !== input.current) done();
    });
  };
  return (
    <input
      ref={input}
      className="field shelf-rename"
      aria-label="Shelf name"
      maxLength={40}
      autoComplete="off"
      autoFocus
      value={value}
      onChange={(e) => {
        latest.current = e.target.value;
        setValue(e.target.value);
      }}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onClose();
        }
      }}
    />
  );
}
