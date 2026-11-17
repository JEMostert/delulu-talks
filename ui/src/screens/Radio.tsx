import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as ipc from "../ipc";
import { Segmented } from "../components/Controls";
import { Icon, type IconName } from "../components/Icon";
import { errorText, type AppState } from "../state";
import {
  aceReady,
  clock,
  engineModels,
  genreColor,
  genreWeight,
  hasWords,
  lyricSections,
  makingShort,
  makingText,
  missingBytes,
  MixWriter,
  readinessSteps,
  voiceName,
  type ReadinessStep,
} from "../radio";
import { downloadPercent, gigabytes, useMusicModels } from "../useMusicModels";

type Apply = (radio: ipc.Radio) => void;

/** Delulu FM: the deck, the words and the programme, with the mix beside them. */
export function Radio({ state }: { state: AppState }) {
  const { view, check, checking, toggle, skip } = state.radio;
  const [now, setNow] = useState(() => Date.now());

  // Check what the station needs each time the page opens; the app keeps the
  // radio's state itself, for the mini player on every page.
  useEffect(() => {
    void check();
  }, [check]);

  const playing = Boolean(view?.radio.playing && !view.radio.held);
  useEffect(() => {
    if (!playing && !view?.radio.making) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [playing, view?.radio.making]);

  // Space plays or pauses and N skips, unless you are typing or on a control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        target?.closest("input, textarea, select, button, [contenteditable]")
      )
        return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "n" || e.key === "N") {
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, skip]);

  if (!view || !view.radio.available)
    return (
      <div className="radio">
        <header className="radio-head">
          <h1>Delulu FM</h1>
        </header>
        {view ? (
          <p className="inline-error" role="alert">
            <Icon name="alert" /> {view.radio.error}
          </p>
        ) : (
          <p className="muted" role="status">
            Tuning in…
          </p>
        )}
      </div>
    );
  const { radio } = view;
  const steps = readinessSteps(radio.readiness, radio.music);
  const musicReady = steps.every((s) => s.ok || s.optional);
  const showReady = Boolean(radio.readiness && !musicReady);
  const position = Math.min(
    radio.now?.seconds ?? 0,
    radio.position + (playing ? (now - view.at) / 1000 : 0),
  );
  return (
    <div className="radio">
      <header className="radio-head">
        <h1>Delulu FM</h1>
        <EngineButton
          radio={radio}
          onChange={state.radio.apply}
          onModels={() => state.navigate("Models")}
        />
        {radio.onAir && (
          <button
            type="button"
            className="button small"
            data-tip="Stop making songs and free the graphics card"
            disabled={state.radio.busy}
            onClick={() => void state.radio.act(ipc.radioOff)}
          >
            <Icon name="power" size={15} />
            Off air
          </button>
        )}
      </header>
      <div className={`radio-grid ${showReady ? "has-ready" : ""}`}>
        {showReady && (
          <ReadyStrip
            steps={steps}
            checking={checking}
            onCheck={() => void check()}
            onModels={() => state.navigate("Models")}
          />
        )}
        <Deck
          state={state}
          radio={radio}
          now={now}
          position={position}
          musicReady={musicReady}
        />
        <Words item={radio.now} onCopy={state.copy} />
        <Programme radio={radio} now={now} state={state} />
        <MixPanel
          radio={radio}
          onChange={state.radio.apply}
          onVoice={() => state.navigate("Voice")}
        />
      </div>
    </div>
  );
}

/* ---------- Header: the music engine ---------- */

/** Closes on a click outside or Escape, and gives focus back to its button. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector<HTMLElement>("[aria-expanded]")?.focus();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const engineTip: Record<ipc.MusicEngine, string> = {
  yue2: "YuE2 makes a song in about its own length. Non-commercial use only.",
  acestep:
    "ACE-Step makes a song in under a minute. Tested on NVIDIA graphics cards only.",
};

/** The engine's name; it opens the engine choice. Installing is on Models. */
function EngineButton({
  radio,
  onChange,
  onModels,
}: {
  radio: ipc.Radio;
  onChange: Apply;
  onModels: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const { models, error, run } = useMusicModels();
  // Files can appear without a download event (put there by hand, or found by
  // "Check again"): look again when the popover opens or the check finds more.
  const found = radio.readiness
    ? JSON.stringify([radio.readiness.music.model, radio.readiness.music.ace])
    : "";
  useEffect(() => {
    if (open || found) void run(ipc.getMusicModel, []);
  }, [open, found, run]);
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string>();
  const { music } = radio;
  const ace = music.engine === "acestep";
  const ids = engineModels(music);
  const rows = models?.models ?? [];
  const has = (id: string) =>
    rows.some((m) => m.id === id && m.state === "ready");
  const ready = ace
    ? aceReady(
        {
          turbo: has("ace-step-1.5-turbo"),
          lmSmall: has("ace-step-1.5-lm-0.6b"),
          lmLarge: has("ace-step-1.5-lm-4b"),
        },
        music.aceLm,
      )
    : has("yue2-3b-int8");
  const downloading = rows.some(
    (m) => ids.includes(m.id) && m.state === "downloading",
  );
  const percent = downloadPercent(models);
  const choose = async (engine: ipc.MusicEngine, aceLm: ipc.AceLm) => {
    setChoosing(true);
    try {
      onChange(await ipc.radioMusic(engine, aceLm));
      setChooseError(undefined);
    } catch (e) {
      setChooseError(errorText(e));
    } finally {
      setChoosing(false);
    }
  };
  const problem = chooseError ?? error;
  const missing = models && !ready;
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        className="button small quiet engine-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tip={missing ? "Music engine: not installed" : "Music engine"}
        onClick={() => setOpen(!open)}
      >
        <Icon name="box" size={15} />
        {ace ? "ACE-Step 1.5" : "YuE2"}
        {missing && <span className="warn-dot" aria-label="not installed" />}
      </button>
      {open && (
        <div className="pop engine-pop" role="dialog" aria-label="Music engine">
          <div className="pop-line">
            <span data-tip={engineTip[music.engine]}>Engine</span>
            <Segmented
              name="engine"
              label="Music engine"
              value={music.engine}
              disabled={choosing}
              onChange={(v) => void choose(v, music.aceLm)}
              options={[
                { value: "yue2", label: "YuE2" },
                { value: "acestep", label: "ACE-Step" },
              ]}
            />
          </div>
          {ace && (
            <div className="pop-line">
              <span data-tip="Automatic takes 4B, which follows the lyrics best, when 8 GB of graphics memory is free, and 0.6B otherwise">
                Language model
              </span>
              <Segmented
                name="ace-lm"
                label="ACE-Step language model"
                value={music.aceLm}
                disabled={choosing}
                onChange={(v) => void choose(music.engine, v)}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "0.6b", label: "0.6B" },
                  { value: "4b", label: "4B" },
                ]}
              />
            </div>
          )}
          <div className="pop-state">
            {downloading ? (
              <>
                <div
                  className="bar mini-bar"
                  role="progressbar"
                  aria-label="Music engine download"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span style={{ transform: `scaleX(${percent / 100})` }} />
                </div>
                <span className="tabular">Downloading · {percent}%</span>
              </>
            ) : ready ? (
              <span className="pop-ok">
                <Icon name="check" size={15} /> Installed
              </span>
            ) : models ? (
              <span className="pop-warn">
                <Icon name="alert" size={15} />
                Not installed · {gigabytes(missingBytes(models, ids))}
              </span>
            ) : null}
            {models && !ready && (
              <button type="button" className="button small" onClick={onModels}>
                Models
                <Icon name="chevron" size={14} />
              </button>
            )}
          </div>
          {problem && (
            <p className="pop-error" role="alert">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Before the first song ---------- */

function ReadyStrip({
  steps,
  checking,
  onCheck,
  onModels,
}: {
  steps: ReadinessStep[];
  checking: boolean;
  onCheck: () => void;
  onModels: () => void;
}) {
  const todo = steps.filter((s) => !s.ok && !s.unknown);
  const ok = steps.filter((s) => s.ok);
  const unknown = steps.filter((s) => s.unknown);
  return (
    <section className="ready-strip" aria-labelledby="radio-ready-title">
      <h2 id="radio-ready-title">Before the first song</h2>
      <ul>
        {todo.map((step) => (
          <li
            key={step.id}
            className={step.optional ? "todo optional" : "todo"}
            data-tip={step.help}
            tabIndex={0}
          >
            <Icon name="alert" size={14} />
            {step.label}
            <span className="visually-hidden">: {step.help}</span>
          </li>
        ))}
        {unknown.map((step) => (
          <li
            key={step.id}
            className="unknown"
            data-tip={step.help}
            tabIndex={0}
          >
            <Icon name="history" size={14} />
            {step.label}
            <span className="visually-hidden">: {step.help}</span>
          </li>
        ))}
        {ok.length > 0 && (
          <li
            className="ok"
            data-tip={ok.map((s) => s.label).join(" · ")}
            tabIndex={0}
          >
            <Icon name="check" size={14} />
            {ok.length} ready
            <span className="visually-hidden">
              : {ok.map((s) => s.label).join(", ")}
            </span>
          </li>
        )}
      </ul>
      <div className="ready-actions">
        {todo.some((s) => s.models) && (
          <button type="button" className="button small" onClick={onModels}>
            Models
          </button>
        )}
        <button
          type="button"
          className="icon-button tiny"
          aria-label="Check again"
          data-tip={checking ? "Checking…" : "Check again"}
          disabled={checking}
          onClick={onCheck}
        >
          <Icon name="history" size={15} />
        </button>
      </div>
    </section>
  );
}

/* ---------- The deck ---------- */

function GenreTag({
  genre,
  surprise,
  named,
  className = "",
}: {
  genre: string;
  surprise?: boolean;
  /** Tooltip with the name, for a tag a narrow window shrinks to its dot. */
  named?: boolean;
  className?: string;
}) {
  const tip = surprise
    ? `${named ? `${genre}: a surprise` : "A surprise"}, outside your genres`
    : named
      ? genre
      : undefined;
  return (
    <span className={`tag genre-tag ${className}`} data-tip={tip}>
      <i style={{ "--c": genreColor(genre) } as CSSProperties} />
      {genre}
      {surprise && <Icon name="star" size={11} />}
    </span>
  );
}

/** A round icon button on the dark deck. */
function DeckButton({
  icon,
  label,
  onClick,
  pressed,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="deck-button"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

function Deck({
  state,
  radio,
  now,
  position,
  musicReady,
}: {
  state: AppState;
  radio: ipc.Radio;
  now: number;
  position: number;
  musicReady: boolean;
}) {
  const { act, busy, toggle, skip } = state.radio;
  const item = radio.now;
  const song = item?.kind === "song" ? item : null;
  const making = makingShort(radio, now);
  const lock = radio.lock;
  const canPlay =
    radio.playing ||
    Boolean(item) ||
    radio.queue.length > 0 ||
    radio.history.some((i) => i.kind === "song") ||
    musicReady;
  const air = radio.held
    ? "Quiet while you dictate"
    : radio.onAir
      ? radio.playing
        ? "On air"
        : "Paused"
      : "Off air";
  const feedback = (f: ipc.RadioFeedback) =>
    song &&
    void act(() => ipc.radioFeedback(song.id, song.feedback === f ? null : f));
  const lockTip = lock
    ? `Back to the whole mix (on ${lock.genre}${lock.left != null ? `, ${lock.left} left` : ""})`
    : song?.genre
      ? `Stay on ${song.genre} for ${radio.lockSongs} songs`
      : "Stay on this genre";
  return (
    <section className="well deck" aria-label="Now playing">
      <div className="deck-top">
        <span
          className={`on-air ${radio.onAir && radio.playing && !radio.held ? "live" : ""}`}
        >
          {air}
        </span>
        {song?.genre && (
          <GenreTag genre={song.genre} surprise={song.surprise} />
        )}
        {song?.mood && <span className="tag deck-tag">{song.mood}</span>}
        {item?.kind === "break" && <span className="tag deck-tag">Host</span>}
        {item?.request && (
          <span
            className="tag deck-tag"
            data-tip={`Requested: “${item.request}”`}
          >
            <Icon name="send" size={11} />
            Request
          </span>
        )}
        {item?.replay && <span className="tag deck-tag">Replay</span>}
        {lock && (
          <span className="tag deck-tag lock-tag">
            <Icon name="lock" size={11} />
            {lock.genre}
            {lock.left != null && ` · ${lock.left}`}
          </span>
        )}
        <span
          className="deck-making"
          role="status"
          aria-live="polite"
          data-tip={makingText(radio, now) ?? undefined}
        >
          {making ?? (radio.onAir ? "The programme is full" : "")}
        </span>
      </div>
      <h2 className="deck-title">
        {item
          ? item.kind === "break"
            ? "Host break"
            : item.title
          : radio.onAir
            ? "The first song is on its way"
            : "Nothing on air yet"}
      </h2>
      <div className="deck-progress tabular">
        <span>{clock(item ? position : 0)}</span>
        <div
          role="progressbar"
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(item?.seconds ?? 0)}
          aria-valuenow={Math.round(item ? position : 0)}
          aria-valuetext={
            item ? `${clock(position)} of ${clock(item.seconds)}` : undefined
          }
        >
          <span
            style={{
              width: item
                ? `${(100 * position) / Math.max(1, item.seconds)}%`
                : 0,
            }}
          />
        </div>
        <span>{clock(item?.seconds ?? 0)}</span>
      </div>
      <div className="deck-controls">
        <button
          type="button"
          className="deck-play"
          aria-label={radio.playing ? "Pause" : "Play"}
          data-tip={radio.playing ? "Pause (Space)" : "Play (Space)"}
          disabled={busy || !canPlay}
          onClick={toggle}
        >
          <Icon name={radio.playing ? "pause" : "play"} size={20} />
        </button>
        <DeckButton
          icon="skip"
          label="Skip (N)"
          disabled={busy || !item}
          onClick={skip}
        />
        <DeckButton
          icon="like"
          label="More like this"
          pressed={song?.feedback === "like"}
          disabled={!song}
          onClick={() => feedback("like")}
        />
        <DeckButton
          icon="dislike"
          label="Less like this (skips it)"
          pressed={song?.feedback === "dislike"}
          disabled={!song}
          onClick={() => feedback("dislike")}
        />
        <DeckButton
          icon="lock"
          label={lockTip}
          pressed={Boolean(lock)}
          disabled={!lock && !song?.genre}
          onClick={() =>
            void act(lock ? ipc.radioUnlock : () => ipc.radioLock(null))
          }
        />
        <DeckButton
          icon="heart"
          label={song?.saved ? "Saved: keep it no longer" : "Save song"}
          pressed={Boolean(song?.saved)}
          disabled={!song}
          onClick={() =>
            song &&
            void act(() =>
              song.saved ? ipc.radioUnsave(song.id) : ipc.radioSave(song.id),
            )
          }
        />
        <Volume value={radio.volume} />
        <RequestField radio={radio} state={state} />
      </div>
      {radio.lastError && (
        <p className="deck-error" role="alert">
          <Icon name="alert" size={14} />
          <span>{radio.lastError}</span>
        </p>
      )}
    </section>
  );
}

function Volume({ value }: { value: number }) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  return (
    <label
      className="deck-volume"
      data-tip={`Volume ${Math.round(local * 100)}%`}
    >
      <Icon name="volume" size={17} />
      <span className="visually-hidden">Volume</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={local}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          void ipc.radioVolume(v);
        }}
      />
    </label>
  );
}

/** Ask for a song; waiting requests show as a count, then on their songs. */
function RequestField({ radio, state }: { radio: ipc.Radio; state: AppState }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const waiting = radio.requests.filter((r) => !r.answeredBy);
  const send = async () => {
    setSending(true);
    try {
      state.radio.apply(await ipc.radioRequest(text));
      setText("");
    } catch (e) {
      state.setNotice(errorText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      className="deck-request"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void send();
      }}
    >
      <input
        aria-label="Request a song"
        placeholder="Request a song…"
        maxLength={160}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {waiting.length > 0 && (
        <span
          className="request-count tabular"
          data-tip={waiting.map((r) => `“${r.text}”`).join(" · ")}
          aria-label={`${waiting.length} waiting`}
        >
          {waiting.length}
        </span>
      )}
      <button
        type="submit"
        className="deck-button small"
        aria-label="Send request"
        data-tip="Send request"
        disabled={sending || !text.trim()}
      >
        <Icon name="send" size={15} />
      </button>
    </form>
  );
}

/* ---------- Words and programme ---------- */

function Words({
  item,
  onCopy,
}: {
  item: ipc.RadioItem | null;
  onCopy: (text: string) => Promise<void>;
}) {
  const script = item?.kind === "break" ? item.script : null;
  const sections = item?.lyrics ? lyricSections(item.lyrics) : [];
  const words = script ?? (hasWords(sections) ? item?.lyrics : null);
  return (
    <section
      className="glass-card radio-panel words-panel"
      aria-labelledby="radio-words-title"
    >
      <div className="panel-head">
        <h2 id="radio-words-title">
          {item?.kind === "break" ? "The host says" : "Lyrics"}
        </h2>
        {words && (
          <button
            type="button"
            className="icon-button"
            aria-label={script ? "Copy what the host says" : "Copy lyrics"}
            data-tip={script ? "Copy what the host says" : "Copy lyrics"}
            onClick={() => void onCopy(words)}
          >
            <Icon name="copy" size={15} />
          </button>
        )}
      </div>
      <div className="panel-body words">
        {script ? (
          <p className="script">{script}</p>
        ) : hasWords(sections) ? (
          sections.map((s, i) => (
            <div className="lyric-section" key={i}>
              {s.tag && <div className="lyric-tag">{s.tag}</div>}
              {s.lines.map((line, j) => (
                <div key={j}>{line}</div>
              ))}
            </div>
          ))
        ) : (
          <p className="muted words-empty">
            {item ? "An instrumental" : "Words appear here"}
          </p>
        )}
        {item?.request && (
          <p className="words-request">
            <Icon name="send" size={12} /> “{item.request}”
          </p>
        )}
      </div>
    </section>
  );
}

type Tab = "next" | "played" | "saved";

function Programme({
  radio,
  now,
  state,
}: {
  radio: ipc.Radio;
  now: number;
  state: AppState;
}) {
  const [tab, setTab] = useState<Tab>("next");
  const { act } = state.radio;
  const save = (item: ipc.RadioItem) =>
    item.kind === "song" && (
      <RowButton
        icon="heart"
        label={item.saved ? `Unsave ${item.title}` : `Save ${item.title}`}
        pressed={item.saved}
        onClick={() =>
          void act(() =>
            item.saved ? ipc.radioUnsave(item.id) : ipc.radioSave(item.id),
          )
        }
      />
    );
  const items =
    tab === "next"
      ? radio.queue
      : tab === "played"
        ? radio.history
        : radio.saved;
  const m = radio.making;
  const heading = { next: "Up next", played: "Played", saved: "Saved" }[tab];
  return (
    <section
      className="glass-card radio-panel programme"
      aria-label="Programme"
    >
      <div className="panel-head">
        <h2>{heading}</h2>
        <Segmented
          name="programme-tab"
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: "next", label: "Next" },
            { value: "played", label: "Played" },
            {
              value: "saved",
              label: radio.saved.length
                ? `Saved ${radio.saved.length}`
                : "Saved",
            },
          ]}
        />
      </div>
      <ol className="panel-body queue">
        {items.map((item) => (
          <QueueRow key={item.id} item={item}>
            {tab === "saved" ? (
              <>
                <RowButton
                  icon="play"
                  label={`Play ${item.title} now`}
                  onClick={() => void act(() => ipc.radioPlaySaved(item.id))}
                />
                <RowButton
                  icon="heart"
                  label={`Unsave ${item.title}`}
                  pressed
                  onClick={() => void act(() => ipc.radioUnsave(item.id))}
                />
              </>
            ) : (
              save(item)
            )}
          </QueueRow>
        ))}
        {tab === "next" && m && (
          <li
            className="q making"
            data-tip={makingText(radio, now) ?? undefined}
          >
            <span className="q-title">
              <span className="q-spin" aria-hidden="true" />
              {m.kind === "break"
                ? "Host break"
                : m.title
                  ? m.title
                  : m.request
                    ? "Your request"
                    : "Next song"}
              {m.request && <Icon name="send" size={12} />}
            </span>
            {m.genre ? (
              <GenreTag
                genre={m.genre}
                surprise={m.surprise}
                named
                className="plain"
              />
            ) : (
              <span />
            )}
            <span className="q-len">
              {m.progress != null && m.progress > 0
                ? `${Math.round(m.progress * 100)}%`
                : "…"}
            </span>
            <span className="q-actions" />
          </li>
        )}
        {items.length === 0 && !(tab === "next" && m) && (
          <li className="q-empty muted">
            {
              {
                next: radio.onAir ? "Nothing ready yet" : "Off air",
                played: "Nothing played yet",
                saved: "Nothing saved yet",
              }[tab]
            }
          </li>
        )}
      </ol>
    </section>
  );
}

function QueueRow({
  item,
  children,
}: {
  item: ipc.RadioItem;
  children?: ReactNode;
}) {
  const host = item.kind === "break";
  return (
    <li className={`q ${host ? "host" : ""}`}>
      <span className="q-title">
        {host ? (
          <Icon name="voice" size={14} />
        ) : item.request ? (
          <span className="q-mark" data-tip={`Requested: “${item.request}”`}>
            <Icon name="send" size={12} />
            <span className="visually-hidden">Request: </span>
          </span>
        ) : item.surprise ? (
          <span className="q-mark" data-tip="A surprise: outside your genres">
            <Icon name="star" size={12} />
            <span className="visually-hidden">Surprise: </span>
          </span>
        ) : item.replay ? (
          <span className="q-mark" data-tip="Replay">
            <Icon name="history" size={12} />
          </span>
        ) : null}
        <span className="q-name">{host ? "Host break" : item.title}</span>
        {item.feedback && (
          <span
            className="q-mark"
            data-tip={
              item.feedback === "like" ? "You liked it" : "You disliked it"
            }
          >
            <Icon name={item.feedback} size={12} />
          </span>
        )}
      </span>
      {item.genre ? (
        <GenreTag genre={item.genre} named className="plain" />
      ) : (
        <span />
      )}
      <span className="q-len tabular">{clock(item.seconds)}</span>
      <span className="q-actions">{children}</span>
    </li>
  );
}

function RowButton({
  icon,
  label,
  onClick,
  pressed,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="row-button"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

/* ---------- The mix ---------- */

/**
 * The mix as the listener edits it. Every change is sent on its own after a
 * short pause, so a slider drag or a burst of chip clicks is one command (the
 * song being written is drawn again on each). Writes go one at a time with the
 * newest edit, and the station's answer replaces the draft only when no newer
 * edit or write is waiting. A failed write keeps the draft and says so; the
 * next change, Retry or a station command sends it again.
 */
function useMix(radio: ipc.Radio, apply: Apply) {
  const [draft, setDraft] = useState(radio.mix);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [writer] = useState(() => new MixWriter(ipc.radioMix));

  useEffect(() => {
    if (!writer.busy) setDraft(radio.mix);
  }, [radio.mix, writer]);

  const send = useCallback(async () => {
    clearTimeout(timer.current);
    setSaving(true);
    try {
      const r = await writer.flush();
      if (r && !writer.busy) {
        apply(r);
        setDraft(r.mix);
      }
      setError(undefined);
    } catch (e) {
      setError(`Not applied: ${errorText(e)}`);
    } finally {
      setSaving(writer.busy);
    }
  }, [apply, writer]);

  const change = (next: ipc.RadioMix, delay = 450) => {
    setDraft(next);
    writer.edit(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), delay);
  };

  /** A station command, after every edit before it is written, so "save as"
   * keeps them; refused when an edit cannot be written. */
  const run = async (call: () => Promise<ipc.Radio>) => {
    clearTimeout(timer.current);
    setSaving(true);
    try {
      const r = await writer.run(call);
      apply(r);
      if (!writer.busy) setDraft(r.mix);
      setError(undefined);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(writer.busy);
    }
  };

  // Leaving the page sends a waiting edit at once, after the writes before it.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void writer.flush().catch(() => {});
    },
    [writer],
  );

  // An edit that did not reach the station is still waiting to be sent.
  const unsent = Boolean(error) && writer.busy && !saving;
  return { draft, change, run, retry: send, unsent, error, saving };
}

function MixPanel({
  radio,
  onChange,
  onVoice,
}: {
  radio: ipc.Radio;
  onChange: Apply;
  onVoice: () => void;
}) {
  const { draft, change, run, retry, unsent, error, saving } = useMix(
    radio,
    onChange,
  );
  const set = <K extends keyof ipc.RadioMix>(
    key: K,
    value: ipc.RadioMix[K],
    delay?: number,
  ) => change({ ...draft, [key]: value }, delay);
  const toggle = (key: "genres" | "moods", name: string) =>
    set(
      key,
      draft[key].map((c) => (c.name === name ? { ...c, on: !c.on } : c)),
    );
  const add = (key: "genres" | "moods", name: string) =>
    set(key, [
      ...draft[key].filter((c) => c.name.toLowerCase() !== name.toLowerCase()),
      { name, on: true, custom: true },
    ]);
  const remove = (key: "genres" | "moods", name: string) =>
    set(
      key,
      draft[key].filter((c) => c.name !== name),
    );
  const genresOn = draft.genres.filter((c) => c.on).length;
  const allOn = genresOn === draft.genres.length;
  const liked = Object.keys(radio.weights).length > 0;
  return (
    <aside className="glass-card mix" aria-label="Mix">
      <section className="mix-top">
        <div className="mix-head">
          <h2>Mix</h2>
          <button
            type="button"
            className="button small shuffle"
            data-tip="Roll a whole new mix"
            onClick={() => void run(ipc.radioShuffle)}
          >
            <Icon name="dice" size={15} />
            Shuffle
          </button>
        </div>
        <Stations radio={radio} run={run} />
      </section>
      <div className="mix-scroll">
        <section aria-labelledby="mix-genres">
          <div className="mix-head">
            <h2 id="mix-genres">Genres</h2>
            <span className="mix-count tabular">
              {genresOn ? `${genresOn} of ${draft.genres.length}` : "any genre"}
            </span>
            {liked && (
              <button
                type="button"
                className="icon-button tiny"
                aria-label="Forget likes and dislikes"
                data-tip="Forget likes and dislikes"
                onClick={() => void run(() => ipc.radioResetFeedback(null))}
              >
                <Icon name="history" size={14} />
              </button>
            )}
            <button
              type="button"
              className="icon-button tiny"
              aria-label={allOn ? "No genres" : "All genres"}
              data-tip={allOn ? "None" : "All"}
              onClick={() =>
                set(
                  "genres",
                  draft.genres.map((c) => ({ ...c, on: !allOn })),
                )
              }
            >
              <Icon name="checks" size={15} />
            </button>
          </div>
          <div className="chips" role="group" aria-label="Genres">
            {draft.genres.map((c) => {
              const w = genreWeight(radio, c.name);
              return (
                <Chip
                  key={c.name}
                  on={c.on}
                  color={genreColor(c.name)}
                  mark={w > 1.01 ? "up" : w < 0.99 ? "down" : undefined}
                  tip={
                    w > 1.01
                      ? `Liked: comes ${w.toFixed(1)}× as often`
                      : w < 0.99
                        ? `Disliked: comes ${w.toFixed(2)}× as often`
                        : undefined
                  }
                  onClick={() => toggle("genres", c.name)}
                  onRemove={
                    c.custom ? () => remove("genres", c.name) : undefined
                  }
                >
                  {c.name}
                </Chip>
              );
            })}
            {draft.genres.length < 40 && (
              <AddChip
                label="Add your own genre"
                onAdd={(n) => add("genres", n)}
              />
            )}
          </div>
          <label className="mix-slider">
            <span data-tip="How often a song comes from outside your genres">
              Surprise
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={draft.surprise}
              aria-valuetext={`${draft.surprise}%`}
              onChange={(e) => set("surprise", Number(e.target.value))}
            />
            <span className="tabular mix-value">{draft.surprise}%</span>
          </label>
        </section>
        <section aria-labelledby="mix-moods">
          <div className="mix-head">
            <h2 id="mix-moods">Moods</h2>
            <span className="mix-count">
              {draft.moods.some((c) => c.on) ? "" : "any mood"}
            </span>
          </div>
          <div className="chips" role="group" aria-label="Moods">
            {draft.moods.map((c) => (
              <Chip
                key={c.name}
                on={c.on}
                onClick={() => toggle("moods", c.name)}
                onRemove={c.custom ? () => remove("moods", c.name) : undefined}
              >
                {c.name}
              </Chip>
            ))}
            {draft.moods.length < 24 && (
              <AddChip
                label="Add your own mood"
                onAdd={(n) => add("moods", n)}
              />
            )}
          </div>
        </section>
        <section className="mix-options">
          <Option label="Vocals">
            <Segmented
              name="vocals"
              label="Vocals"
              value={draft.vocals}
              onChange={(v) => set("vocals", v)}
              options={[
                { value: "any", label: "Any" },
                { value: "vocal", label: "Sung" },
                { value: "instrumental", label: "Instrumental" },
              ]}
            />
          </Option>
          <Option label="Energy">
            <Segmented
              name="energy"
              label="Energy"
              value={draft.energy}
              onChange={(v) => set("energy", v)}
              options={[
                { value: "any", label: "Any" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Mid" },
                { value: "high", label: "High" },
              ]}
            />
          </Option>
          <Option label="Length" tip="Each song gets a length in this range">
            <LengthRange
              min={draft.lengthMinSeconds}
              max={draft.lengthMaxSeconds}
              limits={radio.lengthLimits}
              onChange={(lo, hi) =>
                change({
                  ...draft,
                  lengthMinSeconds: lo,
                  lengthMaxSeconds: hi,
                })
              }
            />
          </Option>
          <Option label="Host" tip="How often the host talks between songs">
            <Segmented
              name="host"
              label="Host"
              value={draft.host}
              onChange={(v) => set("host", v)}
              options={[
                { value: "off", label: "Off" },
                { value: "sometimes", label: "Sometimes" },
                { value: "often", label: "Often" },
              ]}
            />
          </Option>
          <HostVoice
            language={draft.language}
            onLanguage={(v) => set("language", v)}
            onVoice={onVoice}
          />
          <Option label="Theme" tip="Every song is written around it">
            <input
              className="mix-field"
              aria-label="Theme"
              value={draft.theme}
              maxLength={160}
              placeholder="Optional"
              onChange={(e) => set("theme", e.target.value, 1200)}
            />
          </Option>
        </section>
      </div>
      <footer className="mix-foot" role="status" aria-live="polite">
        {error ? (
          <span className="mix-error">
            <Icon name="alert" size={14} />
            <span data-tip={error}>{error}</span>
            {unsent ? (
              <button
                type="button"
                className="mix-retry"
                onClick={() => void retry()}
              >
                Retry
              </button>
            ) : null}
          </span>
        ) : (
          <>
            <Icon name="info" size={14} />
            {saving ? "Saving…" : "Applies from the next song"}
          </>
        )}
      </footer>
    </aside>
  );
}

function Option({
  label,
  tip,
  children,
}: {
  label: string;
  tip?: string;
  children: ReactNode;
}) {
  return (
    <div className="mix-option">
      <span className="mix-label" data-tip={tip}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** A toggle chip, with an optional colour dot and remove or menu button. */
function Chip({
  on,
  color,
  mark,
  tip,
  onClick,
  onRemove,
  extra,
  children,
}: {
  on: boolean;
  color?: string;
  mark?: "up" | "down";
  tip?: string;
  onClick: () => void;
  onRemove?: () => void;
  extra?: ReactNode;
  children: string;
}) {
  return (
    <span className={`chip ${on ? "on" : ""}`}>
      <button
        type="button"
        className="chip-toggle"
        aria-pressed={on}
        data-tip={tip}
        onClick={onClick}
      >
        {color && (
          <i className="dot" style={{ "--c": color } as CSSProperties} />
        )}
        {children}
        {mark && (
          <span className={`chip-mark ${mark}`} aria-hidden="true">
            {mark === "up" ? "▲" : "▼"}
          </span>
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          className="chip-extra"
          aria-label={`Remove ${children}`}
          data-tip="Remove"
          onClick={onRemove}
        >
          <Icon name="close" size={11} />
        </button>
      )}
      {extra}
    </span>
  );
}

/** "+" that becomes a small field; Enter adds, Escape leaves. */
function AddChip({
  label,
  onAdd,
}: {
  label: string;
  onAdd: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className="chip chip-add"
        aria-label={label}
        data-tip={label}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" size={13} />
      </button>
    );
  const done = () => {
    setOpen(false);
    setText("");
  };
  return (
    <input
      className="chip chip-input"
      aria-label={label}
      placeholder="Name"
      maxLength={32}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Escape") done();
        if (e.key !== "Enter") return;
        e.preventDefault();
        const name = text.trim();
        if (name) onAdd(name);
        done();
      }}
    />
  );
}

/** Stations as chips: tune in, save the mix as one, rename or delete yours. */
function Stations({
  radio,
  run,
}: {
  radio: ipc.Radio;
  run: (call: () => Promise<ipc.Radio>) => Promise<boolean>;
}) {
  return (
    <div className="chips" role="group" aria-label="Stations">
      {radio.stations.map((st) => (
        <Chip
          key={st.id}
          on={st.active}
          onClick={() => void run(() => ipc.radioStationActivate(st.id))}
          extra={!st.builtin && <StationMenu station={st} run={run} />}
        >
          {st.name}
        </Chip>
      ))}
      <NamePopover
        icon="plus"
        label="Save this mix as a station"
        submit="Save"
        className="chip chip-add"
        onSubmit={(name) => run(() => ipc.radioStationSave(name))}
      />
    </div>
  );
}

function StationMenu({
  station,
  run,
}: {
  station: ipc.RadioStation;
  run: (call: () => Promise<ipc.Radio>) => Promise<boolean>;
}) {
  const { open, setOpen, ref } = usePopover();
  const [renaming, setRenaming] = useState(false);
  return (
    <span className="pop-anchor" ref={ref}>
      <button
        type="button"
        className="chip-extra"
        aria-label={`${station.name}: more`}
        aria-expanded={open}
        aria-haspopup="menu"
        data-tip="Rename or delete"
        onClick={() => {
          setRenaming(false);
          setOpen(!open);
        }}
      >
        <Icon name="more" size={13} />
      </button>
      {open && (
        <div className="pop menu-pop" role="menu" aria-label={station.name}>
          {renaming ? (
            <NameForm
              initial={station.name}
              submit="Rename"
              label={`New name for ${station.name}`}
              onSubmit={async (name) => {
                const ok = await run(() =>
                  ipc.radioStationRename(station.id, name),
                );
                if (ok) setOpen(false);
                return ok;
              }}
            />
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                autoFocus
                onClick={() => setRenaming(true)}
              >
                <Icon name="edit" size={14} />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item danger"
                onClick={() => {
                  setOpen(false);
                  void run(() => ipc.radioStationDelete(station.id));
                }}
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

function NamePopover({
  icon,
  label,
  submit,
  className,
  onSubmit,
}: {
  icon: IconName;
  label: string;
  submit: string;
  className: string;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <span className="pop-anchor" ref={ref}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tip={label}
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} size={13} />
      </button>
      {open && (
        <div className="pop name-pop" role="dialog" aria-label={label}>
          <NameForm
            initial=""
            submit={submit}
            label="Station name"
            onSubmit={async (name) => {
              const ok = await onSubmit(name);
              if (ok) setOpen(false);
              return ok;
            }}
          />
        </div>
      )}
    </span>
  );
}

function NameForm({
  initial,
  submit,
  label,
  onSubmit,
}: {
  initial: string;
  submit: string;
  label: string;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className="name-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void onSubmit(name.trim());
      }}
    >
      <input
        className="mix-field"
        aria-label={label}
        placeholder="Name"
        maxLength={24}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="submit"
        className="button small primary"
        disabled={!name.trim()}
      >
        {submit}
      </button>
    </form>
  );
}

/** Two handles on one track: the shortest and the longest song. */
function LengthRange({
  min,
  max,
  limits,
  onChange,
}: {
  min: number;
  max: number;
  limits: { min: number; max: number };
  onChange: (min: number, max: number) => void;
}) {
  const span = Math.max(1, limits.max - limits.min);
  const at = (v: number) => (v - limits.min) / span;
  return (
    <div className="length">
      <div
        className="length-track"
        style={{ "--lo": at(min), "--hi": at(max) } as CSSProperties}
      >
        <input
          type="range"
          aria-label="Shortest song"
          min={limits.min}
          max={limits.max}
          step={5}
          value={min}
          aria-valuetext={clock(min)}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(Math.min(v, max), max);
          }}
        />
        <input
          type="range"
          aria-label="Longest song"
          min={limits.min}
          max={limits.max}
          step={5}
          value={max}
          aria-valuetext={clock(max)}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(min, Math.max(v, min));
          }}
        />
      </div>
      <span className="tabular mix-value">
        {min === max ? clock(min) : `${clock(min)}–${clock(max)}`}
      </span>
    </div>
  );
}

const languages = ["English", "Dutch"];

/** The host's voice (shared with the Voice page) and the station's language. */
function HostVoice({
  language,
  onLanguage,
  onVoice,
}: {
  language: string;
  onLanguage: (language: string) => void;
  onVoice: () => void;
}) {
  const [status, setStatus] = useState<ipc.VoiceStatus | null>(null);
  const [error, setError] = useState<string>();
  const id = useId();
  useEffect(() => {
    let active = true;
    ipc
      .getVoiceStatus()
      .then((s) => active && setStatus(s))
      .catch((e) => active && setError(errorText(e)));
    return () => {
      active = false;
    };
  }, []);
  const choose = (voice: string) => {
    if (status) setStatus({ ...status, radioVoice: voice });
    void ipc
      .setVoice("radio", voice)
      .then(() => setError(undefined))
      .catch((e) => setError(errorText(e)));
  };
  const options = languages.includes(language)
    ? languages
    : [...languages, language];
  return (
    <div className="mix-option">
      <label
        className="mix-label"
        htmlFor={`${id}-voice`}
        data-tip={error ?? "The host’s AI voice and the station’s language"}
      >
        Voice
      </label>
      <div className="voice-pair">
        {status?.ready ? (
          <span className="select">
            <select
              id={`${id}-voice`}
              value={status.radioVoice}
              onChange={(e) => choose(e.target.value)}
            >
              {status.voices.map((v) => (
                <option key={v} value={v}>
                  {voiceName(v)}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <button
            id={`${id}-voice`}
            type="button"
            className="button small voice-setup"
            data-tip={error ?? "No host until a voice is installed"}
            onClick={onVoice}
          >
            Set up
          </button>
        )}
        <span className="select">
          <select
            aria-label="Language"
            value={language}
            onChange={(e) => onLanguage(e.target.value)}
          >
            {options.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </span>
      </div>
    </div>
  );
}
