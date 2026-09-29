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
        className="page-tabs max-[900px]:gap-[15px] max-[900px]:flex-wrap"
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
      <section className="flex items-center justify-between gap-[30px] py-[18px] max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-3.5">
        <div>
          <h2>
            {kind === "correction"
              ? "Fix recurring recognition mistakes"
              : "Insert saved text by voice"}
          </h2>
          <p className="text-muted max-w-[480px] text-[13px] mt-3">
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
      <div className="flex items-center gap-3.5 max-[700px]:flex-wrap">
        <label className="search-box max-[700px]:basis-full">
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
      <section className="border border-line rounded-panel bg-surface shadow-panel backdrop-blur-xl overflow-hidden">
        {filtered.map((word) => (
          <article
            className="flex items-center px-[18px] py-4 gap-4 border-b border-line last:border-0 max-[700px]:flex-wrap max-[700px]:p-3.5"
            key={word.id}
          >
            <span className="size-[38px] rounded-xl bg-accent-soft text-accent-ink grid place-items-center shrink-0 text-[16px]">
              {ruleKind(word) === "shortcut" ? "↳" : "Aa"}
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-[15px] flex gap-2 items-center break-words">
                {word.term}
                {!ruleTriggers(word).length && (
                  <span className="badge">Needs a correction phrase</span>
                )}
              </h3>
              <p className="text-[12px] text-muted mt-[5px] break-words">
                {ruleKind(word) === "shortcut"
                  ? `Say “${word.term}”`
                  : word.soundsLike
                    ? `Replace “${word.soundsLike}”`
                    : "Add the text the recognizer gets wrong to activate this rule."}
              </p>
              {word.replacement && (
                <blockquote className="text-[12px] text-muted break-words my-3 mx-0 px-3.5 py-2.5 border-l-2 border-line-strong whitespace-pre-wrap">
                  {word.replacement}
                </blockquote>
              )}
            </div>
            <div className="panel-actions max-[700px]:ml-auto">
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
      <p className="flex items-center justify-center gap-[7px] text-[11px] text-muted">
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
          <div className="border border-line rounded-lg p-3 my-3">
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
            <output
              className="block whitespace-pre-wrap break-words text-[14px] leading-[1.6] mt-3 p-2.5 rounded-[5px] bg-soft"
              aria-label="Rule preview"
            >
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
