import { useId, useMemo, useState } from "react";
import {
  BookOpenText,
  CodeXml,
  Gamepad2,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  ConfirmDialog,
  EmptyState,
  Modal,
  Tabs,
  Toggle,
} from "../components/ui";
import {
  previewPersonalization,
  ruleConflict,
  ruleKind,
  ruleLanguage,
} from "../personalization";
import { MAX_HINT_WORDS, hintWords } from "../recognitionHints";
import { WORD_PACKS, activeRules, type WordPackId } from "../wordPacks";
import type { CustomWord } from "../types";
import { RuleUsagePanel } from "../components/RuleUsagePanel";

const RULE_TABS = [
  ["correction", "My words"],
  ["shortcut", "Text shortcuts"],
] as const;
const PACK_ICONS = { programming: CodeXml, gaming: Gamepad2 };

const splitPhrases = (text: string) =>
  text
    .split(",")
    .map((phrase) => phrase.trim())
    .filter(Boolean);
/** Legacy aliases are edited together with the comma-separated phrases. */
const heardAs = (word: CustomWord) =>
  [...splitPhrases(word.soundsLike), ...(word.aliases ?? [])].join(", ");

/** Aliases are folded into the phrases field, so the saved rule drops them. */
function editedRule(draft: CustomWord, phrases: string): CustomWord {
  const rule = {
    ...draft,
    term: draft.term.trim(),
    soundsLike: splitPhrases(phrases).join(", "),
  };
  delete rule.aliases;
  return rule;
}

export function VocabularyPage({
  words,
  packs,
  hintsActive,
  saving,
  onChange,
  onPacksChange,
}: {
  words: CustomWord[];
  packs: WordPackId[];
  /** Whether the current engine receives the words as recognition hints. */
  hintsActive: boolean;
  saving: boolean;
  onChange: (words: CustomWord[]) => Promise<boolean>;
  onPacksChange: (packs: WordPackId[]) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"correction" | "shortcut">("correction");
  const [query, setQuery] = useState("");
  const [newWord, setNewWord] = useState("");
  const [draft, setDraft] = useState<CustomWord | null>(null);
  const [phrases, setPhrases] = useState("");
  const [remove, setRemove] = useState<CustomWord | null>(null);
  const [testPhrase, setTestPhrase] = useState("");
  const previewTitleId = useId();
  const rules = useMemo(
    () => activeRules({ customWords: words, wordPacks: packs }),
    [words, packs],
  );
  const preview = useMemo(
    () => previewPersonalization(testPhrase, rules),
    [testPhrase, rules],
  );
  const used = useMemo(() => hintWords(rules).length, [rules]);
  const usedWith = (nextWords: CustomWord[], nextPacks = packs) =>
    hintWords(activeRules({ customWords: nextWords, wordPacks: nextPacks }))
      .length;
  const fits = (nextWords: CustomWord[], nextPacks = packs) =>
    usedWith(nextWords, nextPacks) <= Math.max(MAX_HINT_WORDS, used);

  const filtered = words.filter(
    (word) =>
      ruleKind(word) === kind &&
      `${word.term} ${heardAs(word)} ${word.replacement}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const typed = newWord.trim().replace(/\s+/gu, " ");
  const duplicate = words.some(
    (word) =>
      ruleKind(word) === "correction" &&
      word.term.toLowerCase() === typed.toLowerCase(),
  );
  const quickWord: CustomWord = {
    id: "",
    kind: "correction",
    term: typed,
    soundsLike: "",
    replacement: "",
    enabled: true,
  };
  const quickFits = fits([...words, quickWord]);

  const drafted = draft && editedRule(draft, phrases);
  const conflict = drafted ? ruleConflict(drafted, words) : null;
  const shortcut = draft && ruleKind(draft) === "shortcut";
  const invalid =
    !drafted?.term || (shortcut && !drafted.replacement.trim()) || !!conflict;
  const save = async (rule: CustomWord) => {
    const next = words.some((word) => word.id === rule.id)
      ? words.map((word) => (word.id === rule.id ? rule : word))
      : [rule, ...words];
    return onChange(next);
  };

  return (
    <div className="content-stack">
      <section className="settings-group">
        <div className="group-heading">
          <h3>Word packs</h3>
          <p>
            Turn on a pack and its words are recognized and spelled right. Your
            own words always come first.
          </p>
        </div>
        {WORD_PACKS.map((pack) => {
          const on = packs.includes(pack.id);
          const nextPacks = on
            ? packs.filter((id) => id !== pack.id)
            : [...packs, pack.id];
          const needed = on ? 0 : usedWith(words, nextPacks) - used;
          const blocked = !on && !fits(words, nextPacks);
          const Icon = PACK_ICONS[pack.id];
          return (
            <article
              className="setting-row items-center max-[600px]:flex-wrap"
              key={pack.id}
            >
              <span className="size-[34px] rounded-[10px] bg-accent-soft text-accent-ink grid place-items-center shrink-0">
                <Icon className="size-[18px]" />
              </span>
              <div className="flex-1 min-w-0">
                <h3 className="text-[14px] flex flex-wrap gap-2 items-center">
                  {pack.name}
                  <span className="badge neutral">
                    {pack.words.length} words
                  </span>
                </h3>
                <p className="text-[12px] text-muted mt-1">
                  {pack.description}
                </p>
                <p className="text-[12px] text-muted mt-1 break-words">
                  {pack.words
                    .slice(0, 10)
                    .map(([term]) => term)
                    .join(" · ")}{" "}
                  …
                </p>
                {blocked && (
                  <p className="text-[12px] text-warning mt-1">
                    Needs {needed} words, {Math.max(0, MAX_HINT_WORDS - used)}{" "}
                    left. Turn off another pack or remove some of your words.
                  </p>
                )}
              </div>
              <Toggle
                value={on}
                label={`Use the ${pack.name} pack`}
                disabled={saving || blocked}
                onChange={() => void onPacksChange(nextPacks)}
              />
            </article>
          );
        })}
        <div className="grid gap-2 p-4 border-t border-line">
          <div className="flex justify-between gap-3 text-[12px]">
            <span>Words in use</span>
            <span className={used > MAX_HINT_WORDS ? "text-warning" : ""}>
              {used} / {MAX_HINT_WORDS}
            </span>
          </div>
          <div
            className="h-1.5 rounded-full bg-soft overflow-hidden"
            role="meter"
            aria-label="Words in use"
            aria-valuemin={0}
            aria-valuemax={MAX_HINT_WORDS}
            aria-valuenow={used}
          >
            <div
              className="h-full bg-accent"
              style={{
                width: `${Math.min(100, (used / MAX_HINT_WORDS) * 100)}%`,
              }}
            />
          </div>
          <p className="caption">
            {used > MAX_HINT_WORDS
              ? `Only the first ${MAX_HINT_WORDS} words are sent to the speech model. Turn off a pack or some of your words.`
              : hintsActive
                ? "R2T2 listens for these words while it recognizes your speech. Known misspellings are fixed afterwards."
                : "Known misspellings are fixed after recognition. R2T2 on an NVIDIA GPU with Vocabulary hints on also listens for these words."}
          </p>
        </div>
      </section>

      <div className="vocabulary-head">
        <Tabs
          label="Your words and shortcuts"
          tabs={RULE_TABS}
          value={kind}
          onChange={setKind}
        />
        {kind === "shortcut" && (
          <button
            className="primary-button"
            disabled={saving || words.length >= 500}
            onClick={() => {
              setPhrases("");
              setDraft({
                id: crypto.randomUUID(),
                kind: "shortcut",
                term: "",
                soundsLike: "",
                replacement: "",
                enabled: true,
              });
            }}
          >
            <Plus />
            Add shortcut
          </button>
        )}
      </div>
      {kind === "correction" && (
        <form
          className="flex items-start gap-2.5 max-[600px]:flex-wrap"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typed || duplicate || !quickFits) return;
            void onChange([
              { ...quickWord, id: crypto.randomUUID() },
              ...words,
            ]).then((saved) => saved && setNewWord(""));
          }}
        >
          <label className="field flex-1 min-w-[220px] m-0">
            <input
              aria-label="New word"
              value={newWord}
              maxLength={256}
              onChange={(event) => setNewWord(event.target.value)}
              placeholder="Add a word, name or term, such as Delulu…"
            />
            {duplicate && <small>That word is already in your list.</small>}
            {typed && !duplicate && !quickFits && (
              <small className="text-warning">
                All {MAX_HINT_WORDS} words are in use. Turn off a pack or remove
                a word first.
              </small>
            )}
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={
              saving || !typed || duplicate || !quickFits || words.length >= 500
            }
          >
            <Plus />
            Add word
          </button>
        </form>
      )}
      {words.length > 8 && (
        <label className="search-box">
          <Search />
          <input
            aria-label="Search your words"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your words…"
          />
        </label>
      )}
      <section className="settings-group">
        {filtered.map((word) => {
          const fixes = heardAs(word);
          const enabling = !word.enabled;
          const blocked =
            enabling &&
            !fits(
              words.map((item) =>
                item.id === word.id ? { ...item, enabled: true } : item,
              ),
            );
          return (
            <article
              className="setting-row items-center max-[600px]:flex-wrap"
              key={word.id}
            >
              <span className="size-[34px] rounded-[10px] bg-accent-soft text-accent-ink grid place-items-center shrink-0 text-[14px] font-semibold">
                {ruleKind(word) === "shortcut" ? "↳" : "Aa"}
              </span>
              <div className="flex-1 min-w-0">
                <h3 className="text-[14px] flex flex-wrap gap-2 items-center break-words">
                  {word.term}
                  {ruleLanguage(word) && (
                    <span className="badge neutral">{ruleLanguage(word)}</span>
                  )}
                </h3>
                {ruleKind(word) === "shortcut" ? (
                  <blockquote className="text-[12px] text-muted break-words my-2 mx-0 px-3.5 py-2 border-l-2 border-line-strong whitespace-pre-wrap">
                    {word.replacement}
                  </blockquote>
                ) : (
                  fixes && (
                    <p className="text-[12px] text-muted mt-1 break-words">
                      Fixes “{fixes.split(", ").join("”, “")}”
                    </p>
                  )
                )}
              </div>
              <div className="panel-actions max-[700px]:ml-auto">
                <Toggle
                  value={word.enabled}
                  label={`Enable ${word.term}`}
                  disabled={saving || blocked}
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
                    setPhrases(heardAs(word));
                    setDraft({ ...word, kind: ruleKind(word) });
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
          );
        })}
        {!filtered.length && (
          <EmptyState
            icon={BookOpenText}
            title={
              query
                ? "Nothing found"
                : kind === "correction"
                  ? "No words of your own yet"
                  : "No text shortcuts yet"
            }
          >
            {query
              ? "Try a different search."
              : kind === "correction"
                ? "Add names and terms the word packs don't cover. Correcting a transcript can also remember a word."
                : "Say a trigger such as “my signature” to insert a saved block of text."}
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
            <h3 id={previewTitleId}>Try your words</h3>
            <p className="text-[12px] text-muted mt-2">
              Type text as the recognizer might write it to see what gets fixed.
              Nothing is saved.
            </p>
          </div>
          <label className="field">
            Test phrase
            <textarea
              aria-label="Test saved rules"
              maxLength={2000}
              value={testPhrase}
              onChange={(event) => setTestPhrase(event.target.value)}
              placeholder="push it to git hub and run cube control apply…"
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
              <p className="col-span-full text-[12px] text-muted">
                {preview.matches.length
                  ? `Fixed: ${preview.matches
                      .map((match) => `“${match.matchedText}” → ${match.term}`)
                      .join(", ")}`
                  : "Nothing to fix in this phrase."}
              </p>
            </div>
          )}
        </section>
      </details>
      <details className="disclosure">
        <summary>Usage</summary>
        <RuleUsagePanel words={words} />
      </details>
      {draft && drafted && (
        <Modal
          title={
            words.some((word) => word.id === draft.id)
              ? shortcut
                ? "Edit shortcut"
                : "Edit word"
              : "New text shortcut"
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
                disabled={saving || invalid}
                onClick={async () => {
                  if (await save(drafted)) setDraft(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <label className="field">
            {shortcut ? "When I say" : "Word"}
            <input
              autoFocus
              aria-label={shortcut ? "Trigger phrase" : "Word"}
              maxLength={256}
              value={draft.term}
              onChange={(e) => setDraft({ ...draft, term: e.target.value })}
              placeholder={shortcut ? "my signature" : "Delulu"}
            />
          </label>
          {shortcut && (
            <label className="field">
              Insert this text
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
          )}
          <label className="field">
            {shortcut ? "Or when I say" : "Often written as"}
            <small>Optional · separate phrases with commas</small>
            <input
              aria-label={
                shortcut ? "Alternative triggers" : "Often written as"
              }
              maxLength={1024}
              value={phrases}
              onChange={(e) => setPhrases(e.target.value)}
              placeholder={shortcut ? "my sign off" : "de lulu, the lulu"}
            />
          </label>
          {conflict && (
            <p className="field-error break-words" role="alert">
              {conflict}
            </p>
          )}
        </Modal>
      )}
      {remove && (
        <ConfirmDialog
          title={`Delete “${remove.term}”?`}
          confirmLabel="Delete"
          onClose={() => setRemove(null)}
          onConfirm={() =>
            void onChange(words.filter((word) => word.id !== remove.id))
          }
        >
          <p>Saved transcripts stay unchanged.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
