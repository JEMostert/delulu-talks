import { useId, useMemo, useState } from "react";
import { BookOpenText, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ConfirmDialog, EmptyState, Modal, Toggle } from "../components/ui";
import { VocabularyBulk } from "../components/VocabularyBulk";
import { VocabularyTransfer } from "../components/VocabularyTransfer";
import {
  aliasError,
  normalizeAliases,
  personalize,
  previewPersonalization,
  ruleConflict,
  ruleKind,
  ruleLanguage,
  ruleTriggers,
} from "../personalization";
import { LANGUAGES } from "../data";
import type { CustomWord } from "../types";
import { RuleUsagePanel } from "../components/RuleUsagePanel";

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
  const [testPhrase, setTestPhrase] = useState("");
  const previewTitleId = useId();
  const preview = useMemo(
    () => previewPersonalization(testPhrase, words),
    [testPhrase, words],
  );
  const filtered = words.filter(
    (word) =>
      ruleKind(word) === kind &&
      `${word.term} ${word.soundsLike} ${(word.aliases ?? []).join(" ")} ${word.replacement}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const conflict = draft ? ruleConflict(draft, words) : null;
  const shortcut = draft && ruleKind(draft) === "shortcut";
  const aliasesError = draft ? aliasError(draft.aliases) : null;
  const invalid =
    !draft?.term.trim() ||
    (shortcut
      ? !draft.replacement.trim()
      : !ruleTriggers(draft).length ||
        ruleTriggers(draft).every((phrase) => phrase === draft.term.trim()));
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
                <span className="badge">
                  {ruleLanguage(word) || "All languages"}
                </span>
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
              {!!word.aliases?.length && (
                <p className="text-[12px] text-muted mt-[5px] break-words">
                  Aliases:{" "}
                  {word.aliases.map((alias) => `“${alias}”`).join(" · ")}
                </p>
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
      <details className="disclosure">
        <summary>Try a phrase</summary>{" "}
        <section
          className="border border-line rounded-panel bg-surface p-[18px] content-stack"
          aria-labelledby={previewTitleId}
        >
          <div>
            <h3 id={previewTitleId}>Try your saved rules</h3>
            <p className="text-[12px] text-muted mt-2">
              See how enabled corrections and text shortcuts work together.
              Testing a phrase does not save it or change your transcripts.
            </p>
          </div>
          <label className="field">
            Test phrase
            <textarea
              aria-label="Test saved rules"
              maxLength={2000}
              value={testPhrase}
              onChange={(event) => setTestPhrase(event.target.value)}
              placeholder="Type a recognized phrase to try your saved rules…"
            />
          </label>
          {testPhrase && (
            <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
              <div>
                <h4 className="caption">Original</h4>
                <output
                  aria-label="Original test phrase"
                  className="block whitespace-pre-wrap break-words text-[14px] leading-[1.6] mt-2 p-3 rounded-lg bg-soft"
                >
                  {preview.original}
                </output>
              </div>
              <div>
                <h4 className="caption">Result</h4>
                <output
                  aria-label="Saved rules result"
                  className="block whitespace-pre-wrap break-words text-[14px] leading-[1.6] mt-2 p-3 rounded-lg bg-soft"
                >
                  {preview.result}
                </output>
              </div>
              <div className="col-span-full">
                <h4 className="caption">Matched rules</h4>
                {preview.matches.length ? (
                  <ol
                    aria-label="Matched saved rules"
                    className="list-none p-0 m-0 mt-2 content-stack gap-2"
                  >
                    {preview.matches.map((match) => (
                      <li
                        key={`${match.ruleId}-${match.index}`}
                        className="border border-line rounded-lg p-3 text-[12px] break-words"
                      >
                        <span className="badge">
                          {match.kind === "shortcut"
                            ? "Text shortcut"
                            : "Correction"}
                        </span>{" "}
                        <strong>{match.term}</strong>
                        <p className="text-muted mt-2">
                          Matched “{match.matchedText}” · trigger “
                          {match.trigger}”
                        </p>
                        <p className="whitespace-pre-wrap mt-2">
                          {match.replacement}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-[12px] text-muted mt-2">
                    No enabled rules matched this phrase.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      </details>
      <details className="disclosure">
        <summary>Manage rules</summary>{" "}
        <VocabularyBulk words={words} saving={saving} onChange={onChange} />
        <VocabularyTransfer words={words} saving={saving} onChange={onChange} />
      </details>
      <details className="disclosure">
        <summary>Usage & details</summary>
        <RuleUsagePanel words={words} />{" "}
        <p className="flex items-center justify-center gap-[7px] text-[11px] text-muted">
          Rules apply to clean output. Original speech and word timings stay
          untouched. These rules do not train the speech model.
        </p>
      </details>
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
                disabled={saving || !!invalid || !!conflict || !!aliasesError}
                onClick={async () => {
                  const normalized = {
                    ...draft,
                    term: draft.term.trim(),
                    soundsLike: draft.soundsLike.trim(),
                    replacement: draft.replacement,
                    aliases: normalizeAliases(draft.aliases),
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
          <label className="field">
            Rule language
            <select
              aria-label="Rule language"
              value={draft.language ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, language: e.target.value || undefined })
              }
            >
              <option value="">All languages</option>
              {draft.language &&
                !LANGUAGES.some(([code]) => code === draft.language) && (
                  <option value={draft.language}>{draft.language}</option>
                )}
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <small>
              Scoped rules apply only to results in this language. Unknown
              languages use global rules only.
            </small>
          </label>
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
          <label className="field">
            Pronunciation & recognition aliases
            <small>
              Optional · one exact phrase per line, up to 32. Commas stay
              literal.
            </small>
            <textarea
              aria-label="Pronunciation and recognition aliases"
              maxLength={16_384}
              value={(draft.aliases ?? []).join("\n")}
              onChange={(e) =>
                setDraft({ ...draft, aliases: e.target.value.split("\n") })
              }
              placeholder={
                shortcut
                  ? "my sign off\nmy closing text"
                  : "de loo loo\ndel loo loo"
              }
            />
          </label>
          {aliasesError && (
            <p className="field-error" role="alert">
              {aliasesError}
            </p>
          )}
          {conflict && (
            <p className="field-error break-words" role="alert">
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
                    : ruleTriggers(draft)[0] || "Type a recognized phrase"
                }
              />
            </label>
            <output
              className="block whitespace-pre-wrap break-words text-[14px] leading-[1.6] mt-3 p-2.5 rounded-[5px] bg-soft"
              aria-label="Rule preview"
            >
              {sample
                ? personalize(
                    sample,
                    [{ ...draft, enabled: true }],
                    draft.language,
                  )
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
