import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { isTermList, restorePaste, serialQueue, termCount } from "../helpers";
import { IconButton, Switch, Tag } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState, type Page } from "../state";

/**
 * Runs one vocabulary change and keeps the result; errors become a notice. Changes
 * run one at a time, so every reply is newer than the one before it.
 */
type Run = (
  call: () => Promise<ipc.Vocabulary>,
) => Promise<ipc.Vocabulary | undefined>;

/** Shelves of names and terms that cleanup listens for: the list left, one shelf right. */
export function Vocabulary({ state }: { state: AppState }) {
  const { settings, cleanupStatus, setNotice, navigate } = state;
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
  const [selectedId, setSelectedId] = useState<string>();
  /** A shelf just made: its term field takes focus. */
  const [fresh, setFresh] = useState<string>();
  if (!settings) return null;
  const shelves = vocabulary?.shelves ?? [];
  const selected = shelves.find((s) => s.id === selectedId) ?? shelves[0];
  const select = (id: string) => {
    setSelectedId(id);
    setFresh(undefined);
  };
  const added = (value: ipc.Vocabulary | undefined) => {
    const shelf = value?.shelves[value.shelves.length - 1];
    if (shelf) {
      setSelectedId(shelf.id);
      setFresh(shelf.id);
    }
    return value !== undefined;
  };
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Vocabulary</h1>
        {vocabulary && vocabulary.usedTerms < vocabulary.activeTerms && (
          <Tag
            tone="warn"
            tip="Cleanup reads only the first terms. Turn off shelves you don’t need right now."
          >
            <Icon name="alert" size={12} />
            {vocabulary.usedTerms} of {vocabulary.activeTerms} terms used
          </Tag>
        )}
        <CleanupTag
          enabled={settings.cleanup}
          status={cleanupStatus}
          onNavigate={navigate}
        />
      </header>
      <div className="vocab-panes">
        <section className="glass-card shelf-list" aria-label="Shelves">
          {shelves.length > 0 && (
            <ul>
              {shelves.map((shelf) => (
                <ShelfRow
                  key={shelf.id}
                  shelf={shelf}
                  selected={shelf.id === selected?.id}
                  onSelect={() => select(shelf.id)}
                  onEnable={(enabled) =>
                    void run(() => ipc.setShelfEnabled(shelf.id, enabled))
                  }
                />
              ))}
            </ul>
          )}
          {vocabulary && (
            <NewShelf
              onAdd={async (name) => added(await run(() => ipc.addShelf(name)))}
            />
          )}
          {vocabulary && vocabulary.presets.length > 0 && (
            <div className="presets">
              <h2 className="card-label">Ready-made</h2>
              <div className="preset-chips">
                {vocabulary.presets.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className="preset-chip"
                    aria-label={`Add ${preset.name}, ${termCount(preset.terms.length)}`}
                    data-tip={`${termCount(preset.terms.length)}: ${preset.terms.slice(0, 4).join(", ")}…`}
                    onClick={async () =>
                      added(await run(() => ipc.addPresetShelf(preset.key)))
                    }
                  >
                    <Icon name="plus" size={13} />
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
        <section
          className="glass-card shelf-pane"
          aria-label={selected ? selected.name : "Shelf"}
        >
          {selected ? (
            <ShelfPane
              key={selected.id}
              shelf={selected}
              focus={fresh === selected.id}
              run={run}
              setNotice={setNotice}
            />
          ) : (
            vocabulary && (
              <div className="pane-empty">
                <span className="jar-glyph large" aria-hidden="true" />
                <p>No shelves yet</p>
                <p className="line-note">
                  Add one for names you say, like T3 Code.
                </p>
              </div>
            )
          )}
        </section>
      </div>
    </div>
  );
}

/** Cleanup's state as one small tag; it leads to where it can be fixed. */
function CleanupTag({
  enabled,
  status,
  onNavigate,
}: {
  enabled: boolean;
  status?: ipc.CleanupStatus;
  onNavigate: (page: Page) => void;
}) {
  if (!enabled || status?.state === "off")
    return (
      <button
        type="button"
        className="tag plain tag-button"
        data-tip="Vocabulary is used while Clean up text is on (Dictate)"
        onClick={() => onNavigate("Dictate")}
      >
        Cleanup off
      </button>
    );
  if (!status) return null;
  if (status.state === "ready")
    return (
      <Tag tone="ok" tip={status.backend ?? undefined}>
        Cleanup ready
      </Tag>
    );
  if (status.state === "loading") return <Tag>Cleanup loading</Tag>;
  if (status.state === "downloading") {
    const percent = status.totalBytes
      ? Math.round((status.doneBytes / status.totalBytes) * 100)
      : 0;
    return <Tag>Cleanup model {percent}%</Tag>;
  }
  return (
    <button
      type="button"
      className="tag warn tag-button"
      data-tip={status.error ?? "Download the cleanup model on the Models page"}
      onClick={() => onNavigate("Models")}
    >
      {status.state === "error" ? "Cleanup failed" : "Cleanup model missing"}
      <Icon name="chevron" size={12} />
    </button>
  );
}

function ShelfRow({
  shelf,
  selected,
  onSelect,
  onEnable,
}: {
  shelf: ipc.Shelf;
  selected: boolean;
  onSelect: () => void;
  onEnable: (enabled: boolean) => void;
}) {
  const count = termCount(shelf.terms.length);
  return (
    <li
      className={`shelf-row ${selected ? "selected" : ""} ${shelf.enabled ? "" : "off"}`}
    >
      <button
        type="button"
        className="shelf-pick"
        aria-current={selected ? "true" : undefined}
        aria-label={`${shelf.name}, ${count}${shelf.enabled ? "" : ", off"}`}
        onClick={onSelect}
      >
        <span className="jar-glyph" aria-hidden="true" />
        <span className="shelf-name">{shelf.name}</span>
        <span className="shelf-count tabular" aria-hidden="true">
          {shelf.terms.length}
        </span>
      </button>
      <span
        className="shelf-switch"
        data-tip={
          shelf.enabled
            ? "Cleanup listens for these words"
            : "Off: cleanup ignores this shelf"
        }
      >
        <Switch
          id={`shelf-${shelf.id}`}
          label={`Use ${shelf.name}`}
          checked={shelf.enabled}
          onChange={onEnable}
        />
      </span>
    </li>
  );
}

/** "New shelf" opens a name field in place; Enter makes the shelf. */
function NewShelf({ onAdd }: { onAdd: (name: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!editing)
    return (
      <button
        type="button"
        className="shelf-new"
        onClick={() => setEditing(true)}
      >
        <Icon name="plus" size={15} />
        New shelf
      </button>
    );
  const submit = () => {
    if (!name.trim()) return;
    const submitted = name;
    void onAdd(submitted).then((ok) => {
      if (!ok) return;
      // Keep a name typed while the shelf was saving.
      setName((now) => (now === submitted ? "" : now));
      setEditing(false);
    });
  };
  return (
    <form
      className="shelf-new-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        className="text-field small"
        aria-label="New shelf name"
        placeholder="Shelf name"
        maxLength={40}
        autoComplete="off"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (!name.trim()) setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setName("");
            setEditing(false);
          }
        }}
      />
      <IconButton
        icon="check"
        label="Add shelf"
        disabled={!name.trim()}
        onClick={submit}
      />
    </form>
  );
}

/** One shelf: rename, add terms, its terms as chips, delete. */
function ShelfPane({
  shelf,
  focus,
  run,
  setNotice,
}: {
  shelf: ipc.Shelf;
  focus: boolean;
  run: Run;
  setNotice: (notice: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);
  async function add(text: string) {
    const value = await run(() => ipc.addTerms(shelf.id, text));
    if (!value) return false;
    const after = value.shelves.find((s) => s.id === shelf.id);
    if (after && after.terms.length === shelf.terms.length)
      setNotice(`Already on ${shelf.name}`);
    return true;
  }
  const remove = () => {
    setConfirming(false);
    void run(() => ipc.deleteShelf(shelf.id));
  };
  return (
    <>
      <header className="pane-bar">
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
          <>
            <h2 className="shelf-title">{shelf.name}</h2>
            <IconButton
              icon="edit"
              label={`Rename ${shelf.name}`}
              onClick={() => setRenaming(true)}
            />
          </>
        )}
        {!shelf.enabled && (
          <Tag tone="plain" tip="Cleanup ignores this shelf">
            Off
          </Tag>
        )}
        <input
          ref={field}
          className="text-field small term-field"
          aria-label={`Add terms to ${shelf.name}`}
          placeholder="Add a term, or paste a list"
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
        <IconButton
          icon="trash"
          label={`Delete ${shelf.name}`}
          tone="danger"
          onClick={() => (shelf.terms.length ? setConfirming(true) : remove())}
        />
      </header>
      {confirming && (
        <div className="confirm pane-confirm" role="alert">
          <p>
            Delete {shelf.name} and its {termCount(shelf.terms.length)}?
          </p>
          <button
            type="button"
            className="button small"
            onClick={() => setConfirming(false)}
          >
            Keep it
          </button>
          <button
            type="button"
            className="button small danger"
            onClick={remove}
          >
            Delete
          </button>
        </div>
      )}
      <div className="pane-scroll">
        {shelf.terms.length > 0 ? (
          <ul className="term-list" aria-label={`Terms on ${shelf.name}`}>
            {shelf.terms.map((term) => (
              <li key={term} className="term">
                <span>{term}</span>
                <button
                  type="button"
                  aria-label={`Remove ${term}`}
                  data-tip={`Remove ${term}`}
                  onClick={() => {
                    field.current?.focus();
                    void run(() => ipc.removeTerm(shelf.id, term));
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="terms-empty">No terms yet</p>
        )}
      </div>
    </>
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
      className="text-field small shelf-rename"
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
