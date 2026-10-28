import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { isTermList, termCount } from "../helpers";
import { CleanupControl } from "../components/CleanupControl";
import { IconButton, Row, Switch } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";

/** Runs one vocabulary change and keeps the result; errors become a notice. */
type Run = (
  call: () => Promise<ipc.Vocabulary>,
) => Promise<ipc.Vocabulary | undefined>;

export function Cleanup({ state }: { state: AppState }) {
  const { settings, update, cleanupStatus, setNotice } = state;
  const [vocabulary, setVocabulary] = useState<ipc.Vocabulary>();
  // The shelf just created, so its term field takes focus.
  const [created, setCreated] = useState<string>();
  useEffect(() => {
    let active = true;
    ipc
      .getVocabulary()
      .then((value) => {
        if (active) setVocabulary(value);
      })
      .catch((e) => {
        if (active) setNotice(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [setNotice]);
  const run = useCallback<Run>(
    async (call) => {
      try {
        const value = await call();
        setVocabulary(value);
        return value;
      } catch (e) {
        setNotice(errorText(e));
        return undefined;
      }
    },
    [setNotice],
  );
  if (!settings) return null;
  const shelves = vocabulary?.shelves ?? [];
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
          <div className="empty empty-vocab">
            <p className="empty-title">No vocabularies yet</p>
            <p>
              Speech recognition sometimes mishears names and jargon. Put them
              on a shelf, like “T3 Code” on a Programming shelf, and cleanup
              turns “ghthree code” back into “T3 Code”.
            </p>
          </div>
        )}
        {shelves.map((shelf) => (
          <ShelfCard
            key={shelf.id}
            shelf={shelf}
            run={run}
            focus={shelf.id === created}
            setNotice={setNotice}
          />
        ))}
        {vocabulary && (
          <NewShelf
            first={shelves.length === 0}
            onAdd={async (name) => {
              const value = await run(() => ipc.addShelf(name));
              const shelf = value?.shelves[value.shelves.length - 1];
              if (shelf) setCreated(shelf.id);
              return value !== undefined;
            }}
          />
        )}
      </section>
    </div>
  );
}

function NewShelf({
  first,
  onAdd,
}: {
  first: boolean;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="new-shelf"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        void onAdd(name).then((ok) => {
          if (ok) setName("");
        });
      }}
    >
      <label className="visually-hidden" htmlFor="new-shelf">
        New shelf name
      </label>
      <input
        id="new-shelf"
        className="field"
        placeholder={
          first ? "Name your first shelf, like Programming" : "New shelf name"
        }
        maxLength={40}
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="submit"
        className={first ? "button primary" : "button"}
        disabled={!name.trim()}
      >
        <Icon name="plus" size={16} />
        Add shelf
      </button>
    </form>
  );
}

function ShelfCard({
  shelf,
  run,
  focus,
  setNotice,
}: {
  shelf: ipc.Shelf;
  run: Run;
  focus: boolean;
  setNotice: (notice: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = `terms-${shelf.id}`;
  async function add(text: string) {
    const value = await run(() => ipc.addTerms(shelf.id, text));
    if (!value) return false;
    const after = value.shelves.find((s) => s.id === shelf.id);
    if (after && after.terms.length === shelf.terms.length)
      setNotice(`Already on ${shelf.name}`);
    return true;
  }
  return (
    <article
      className={`group shelf ${shelf.enabled ? "" : "off"}`}
      aria-label={shelf.name}
    >
      <div className="shelf-head">
        <Switch
          id={`shelf-${shelf.id}`}
          label={`Use ${shelf.name}`}
          checked={shelf.enabled}
          onChange={(enabled) =>
            void run(() => ipc.setShelfEnabled(shelf.id, enabled))
          }
        />
        {renaming ? (
          <RenameField
            name={shelf.name}
            onDone={async (name) => {
              if (name.trim() && name.trim() !== shelf.name) {
                const value = await run(() => ipc.renameShelf(shelf.id, name));
                if (!value) return;
              }
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <h3 className="shelf-name">{shelf.name}</h3>
        )}
        <span className="shelf-count">{termCount(shelf.terms.length)}</span>
        {!renaming && (
          <IconButton
            icon="edit"
            label={`Rename ${shelf.name}`}
            onClick={() => setRenaming(true)}
          />
        )}
        <IconButton
          icon="trash"
          tone="danger"
          label={`Delete ${shelf.name}`}
          onClick={() =>
            shelf.terms.length
              ? setConfirming(true)
              : void run(() => ipc.deleteShelf(shelf.id))
          }
        />
      </div>
      {confirming && (
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
            onClick={() => void run(() => ipc.deleteShelf(shelf.id))}
          >
            Delete
          </button>
        </div>
      )}
      {shelf.terms.length > 0 && (
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
      )}
      <label className="visually-hidden" htmlFor={fieldId}>
        Add terms to {shelf.name}
      </label>
      <input
        id={fieldId}
        ref={field}
        className="field"
        placeholder={
          shelf.terms.length
            ? "Add a term"
            : "Add a term, like T3 Code. Paste a list to add several."
        }
        autoComplete="off"
        spellCheck={false}
        autoFocus={focus}
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
          void add(text);
        }}
      />
    </article>
  );
}

function RenameField({
  name,
  onDone,
  onCancel,
}: {
  name: string;
  onDone: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const saving = useRef(false);
  // Escape closes the field; the blur that may follow must not save.
  const cancelled = useRef(false);
  const done = () => {
    if (saving.current || cancelled.current) return;
    saving.current = true;
    void onDone(value).finally(() => {
      saving.current = false;
    });
  };
  return (
    <input
      className="field shelf-rename"
      aria-label="Shelf name"
      maxLength={40}
      autoComplete="off"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
    />
  );
}
