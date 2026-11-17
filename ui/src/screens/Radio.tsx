import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as ipc from "../ipc";
import { Segmented } from "../components/Controls";
import { Icon } from "../components/Icon";
import { errorText, type AppState } from "../state";
import {
  aceReady,
  clock,
  engineModels,
  hasWords,
  lyricSections,
  makingText,
  missingBytes,
  readinessSteps,
} from "../radio";
import { downloadPercent, gigabytes, useMusicModels } from "../useMusicModels";

type View = { radio: ipc.Radio; at: number };

export function Radio({ state }: { state: AppState }) {
  const { setNotice } = state;
  const [view, setView] = useState<View>();
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const apply = useCallback(
    (radio: ipc.Radio) => setView({ radio, at: Date.now() }),
    [],
  );
  const check = useCallback(async () => {
    setChecking(true);
    try {
      apply(await ipc.checkRadio());
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setChecking(false);
    }
  }, [apply, setNotice]);

  useEffect(() => {
    let active = true;
    const unlisten: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      p.then((fn) => (active ? unlisten.push(fn) : fn())).catch(() => {});
    keep(ipc.onRadio((r) => active && apply(r)));
    keep(ipc.onRadioError((m) => active && setNotice(`Delulu FM: ${m}`)));
    ipc
      .getRadio()
      .then((r) => active && apply(r))
      .catch((e) => setNotice(errorText(e)));
    void check();
    // Correct the local clock now and then; events carry every real change.
    const poll = setInterval(() => {
      ipc
        .getRadio()
        .then((r) => active && apply(r))
        .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(poll);
      unlisten.forEach((fn) => fn());
    };
  }, [apply, check, setNotice]);

  const playing = Boolean(view?.radio.playing && !view.radio.held);
  useEffect(() => {
    if (!playing && !view?.radio.making) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [playing, view?.radio.making]);

  const act = useCallback(
    async (call: () => Promise<ipc.Radio>) => {
      setBusy(true);
      try {
        apply(await call());
      } catch (e) {
        setNotice(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [apply, setNotice],
  );

  const toggle = useCallback(() => {
    if (!view) return;
    void act(view.radio.playing ? ipc.radioPause : ipc.radioPlay);
  }, [act, view]);
  const skip = useCallback(() => void act(ipc.radioSkip), [act]);

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

  if (!view)
    return (
      <div className="radio">
        <TitleBlock />
        <p className="muted" role="status">
          Tuning in…
        </p>
      </div>
    );
  const { radio } = view;
  if (!radio.available)
    return (
      <div className="radio">
        <TitleBlock />
        <p className="inline-error" role="alert">
          <Icon name="alert" /> {radio.error}
        </p>
      </div>
    );
  const steps = readinessSteps(radio.readiness, radio.music);
  const musicReady = steps.every((s) => s.ok || s.optional);
  const position = Math.min(
    radio.now?.seconds ?? 0,
    radio.position + (playing ? (now - view.at) / 1000 : 0),
  );
  const making = makingText(radio, now);
  const canPlay =
    radio.playing ||
    Boolean(radio.now) ||
    radio.queue.length > 0 ||
    radio.history.some((i) => i.kind === "song") ||
    musicReady;
  return (
    <div className="radio">
      <TitleBlock />
      {radio.readiness && !musicReady && (
        <Readiness
          steps={steps}
          checking={checking}
          onCheck={() => void check()}
        />
      )}
      <section className="well radio-deck" aria-label="Now playing">
        <div className="deck-label">
          <span className={`on-air ${radio.onAir ? "live" : ""}`}>
            {radio.onAir ? "On air" : "Off air"}
          </span>
          {radio.now && (
            <span className="deck-kind">
              {radio.now.kind === "break"
                ? "Host"
                : radio.now.replay
                  ? "Replay"
                  : radio.now.imported
                    ? "Imported"
                    : "New song"}
            </span>
          )}
        </div>
        {radio.now ? (
          <>
            <h2 className="deck-title">{radio.now.title}</h2>
            <p className="deck-subtitle">{radio.now.subtitle}</p>
            <div
              className="deck-progress"
              role="progressbar"
              aria-label="Position"
              aria-valuemin={0}
              aria-valuemax={Math.round(radio.now.seconds)}
              aria-valuenow={Math.round(position)}
            >
              <span
                style={{
                  width: `${(100 * position) / Math.max(1, radio.now.seconds)}%`,
                }}
              />
            </div>
            <div className="deck-times tabular">
              <span>{clock(position)}</span>
              <span>{clock(radio.now.seconds)}</span>
            </div>
          </>
        ) : (
          <>
            <h2 className="deck-title">Nothing on air yet</h2>
            <p className="deck-subtitle">
              {radio.onAir
                ? "The first song is being made."
                : "Press Play to start the station."}
            </p>
          </>
        )}
        <div className="deck-controls">
          <button
            type="button"
            className="deck-play"
            aria-label={radio.playing ? "Pause" : "Play"}
            title={radio.playing ? "Pause (Space)" : "Play (Space)"}
            disabled={busy || !canPlay}
            onClick={toggle}
          >
            <Icon name={radio.playing ? "pause" : "play"} size={22} />
          </button>
          <button
            type="button"
            className="deck-button"
            aria-label="Skip"
            title="Skip (N)"
            disabled={busy || !radio.now}
            onClick={skip}
          >
            <Icon name="skip" size={18} />
          </button>
          <Volume value={radio.volume} />
          {radio.onAir && (
            <button
              type="button"
              className="deck-off"
              disabled={busy}
              onClick={() => void act(ipc.radioOff)}
            >
              Stop the station
            </button>
          )}
        </div>
        <p className="deck-status" role="status" aria-live="polite">
          {radio.held
            ? "Quiet while you dictate."
            : (making ?? (radio.onAir ? "The programme is full." : ""))}
        </p>
        {radio.lastError && (
          <p className="deck-error" role="alert">
            {radio.lastError}
          </p>
        )}
      </section>
      <div className="radio-columns">
        <Words item={radio.now} />
        <div className="radio-lists">
          <Programme
            title="Up next"
            items={radio.queue}
            empty="Nothing ready yet."
          />
          <Programme
            title="Recently played"
            items={radio.history}
            empty="Nothing played yet."
          />
        </div>
      </div>
      <Requests radio={radio} onChange={apply} />
      <EnginePanel radio={radio} onChange={apply} />
      <DirectionPanel radio={radio} onChange={apply} />
    </div>
  );
}

function TitleBlock() {
  return (
    <div className="title-block">
      <h1>Delulu FM</h1>
    </div>
  );
}

function Readiness({
  steps,
  checking,
  onCheck,
}: {
  steps: ReturnType<typeof readinessSteps>;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <section className="group radio-ready" aria-labelledby="radio-ready-title">
      <div className="radio-ready-head">
        <h2 id="radio-ready-title">Before the first song</h2>
        <button
          type="button"
          className="button"
          disabled={checking}
          onClick={onCheck}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      <ul className="radio-steps">
        {steps.map((step) => (
          <li
            key={step.id}
            className={step.ok ? "ok" : step.unknown ? "unknown" : "todo"}
          >
            <Icon
              name={step.ok ? "check" : step.unknown ? "history" : "alert"}
              size={16}
            />
            <div>
              <span className="step-label">{step.label}</span>
              {!step.ok && <span className="step-help">{step.help}</span>}
            </div>
          </li>
        ))}
      </ul>
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
    <label className="deck-volume" title="Volume">
      <Icon name="volume" size={18} />
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

function Words({ item }: { item: ipc.RadioItem | null }) {
  const script = item?.kind === "break" ? item.script : null;
  const sections = item?.lyrics ? lyricSections(item.lyrics) : [];
  return (
    <section className="group radio-words" aria-labelledby="radio-words-title">
      <h2 id="radio-words-title">
        {item?.kind === "break" ? "The host says" : "Lyrics"}
      </h2>
      {script ? (
        <p className="words">{script}</p>
      ) : hasWords(sections) ? (
        <div className="words lyrics">
          {sections.map((s, i) => (
            <div className="lyric-section" key={i}>
              {s.tag && <div className="lyric-tag">{s.tag}</div>}
              {s.lines.map((line, j) => (
                <div key={j}>{line}</div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">
          {item ? "An instrumental, no words." : "Words appear here."}
        </p>
      )}
      {item?.request && (
        <p className="words-request">Requested: “{item.request}”</p>
      )}
    </section>
  );
}

function Programme({
  title,
  items,
  empty,
}: {
  title: string;
  items: ipc.RadioItem[];
  empty: string;
}) {
  return (
    <section className="group radio-list" aria-label={title}>
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              <span className="list-title">
                {item.kind === "break" ? "Host break" : item.title}
              </span>
              <span className="list-meta tabular">
                {item.replay ? "Replay · " : ""}
                {item.subtitle}
                {" · "}
                {clock(item.seconds)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Requests({
  radio,
  onChange,
}: {
  radio: ipc.Radio;
  onChange: (r: ipc.Radio) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      onChange(await ipc.radioRequest(text));
      setText("");
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="group radio-requests" aria-labelledby="radio-req-title">
      <h2 id="radio-req-title">Request a song</h2>
      <form
        className="request-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="text-field"
          aria-label="Request"
          placeholder="A song about the first snow, slow and warm"
          maxLength={160}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className="button primary"
          disabled={sending || !text.trim()}
        >
          Request
        </button>
      </form>
      {error && (
        <p className="row-error" role="alert">
          {error}
        </p>
      )}
      {radio.requests.length > 0 && (
        <ul className="request-list">
          {radio.requests.map((r) => (
            <li key={r.id}>
              <span>“{r.text}”</span>
              <span className="muted">
                {r.answeredBy
                  ? `became ${r.answeredBy}`
                  : "waiting for the next song"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The mix as plain controls until the Delulu FM page is rebuilt around it. */
function DirectionPanel({
  radio,
  onChange,
}: {
  radio: ipc.Radio;
  onChange: (r: ipc.Radio) => void;
}) {
  const [draft, setDraft] = useState(radio.mix);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState<string>();
  const [custom, setCustom] = useState("");
  const [stationName, setStationName] = useState("");
  const set = <K extends keyof ipc.RadioMix>(
    key: K,
    value: ipc.RadioMix[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };
  const toggle = (key: "genres" | "moods", name: string) =>
    set(
      key,
      draft[key].map((c) => (c.name === name ? { ...c, on: !c.on } : c)),
    );
  /** Run a station command; the answer replaces the draft. */
  const run = async (call: Promise<ipc.Radio>) => {
    try {
      const r = await call;
      onChange(r);
      setDraft(r.mix);
      setSaved(true);
      setError(undefined);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const pool = (key: "genres" | "moods", label: string) => (
    <div className="presets" role="group" aria-label={label}>
      {draft[key].map((c) => (
        <span key={c.name}>
          <button
            type="button"
            className={c.on ? "button primary" : "button"}
            aria-pressed={c.on}
            onClick={() => toggle(key, c.name)}
          >
            {c.name}
          </button>
          {c.custom && (
            <button
              type="button"
              className="button"
              aria-label={`Remove ${c.name}`}
              title={`Remove ${c.name}`}
              onClick={() =>
                set(
                  key,
                  draft[key].filter((x) => x.name !== c.name),
                )
              }
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
  const on = radio.mix.genres.filter((c) => c.on).map((c) => c.name);
  return (
    <details className="group radio-direction">
      <summary>
        <h2>Mix</h2>
        <span className="muted">
          {on.join(", ") || "any genre"} · surprise {radio.mix.surprise}%
        </span>
      </summary>
      <div className="direction-body">
        <div className="presets" role="group" aria-label="Stations">
          {radio.stations.map((st) => (
            <span key={st.id}>
              <button
                type="button"
                className={st.active ? "button primary" : "button"}
                aria-pressed={st.active}
                onClick={() => void run(ipc.radioStationActivate(st.id))}
              >
                {st.name}
              </button>
              {!st.builtin && (
                <button
                  type="button"
                  className="button"
                  aria-label={`Delete ${st.name}`}
                  title={`Delete ${st.name}`}
                  onClick={() => void run(ipc.radioStationDelete(st.id))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <button
            type="button"
            className="button"
            title="Roll a whole new mix"
            onClick={() => void run(ipc.radioShuffle())}
          >
            Shuffle
          </button>
        </div>
        <div className="direction-grid">
          <label>
            <span>Save as station</span>
            <input
              className="text-field"
              value={stationName}
              maxLength={24}
              placeholder="Name"
              onChange={(e) => setStationName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && stationName.trim())
                  void run(ipc.radioStationSave(stationName)).then(
                    (ok) => ok && setStationName(""),
                  );
              }}
            />
          </label>
          <label>
            <span>Add genre</span>
            <input
              className="text-field"
              value={custom}
              maxLength={32}
              placeholder="Genre"
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                const name = custom.trim();
                if (e.key !== "Enter" || !name) return;
                set("genres", [
                  ...draft.genres.filter((c) => c.name !== name),
                  { name, on: true, custom: true },
                ]);
                setCustom("");
              }}
            />
          </label>
        </div>
        <Choice label="Genres">{pool("genres", "Genres")}</Choice>
        <label className="choice">
          <span title="How often a song comes from outside your genres">
            Surprise {draft.surprise}%
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={draft.surprise}
            onChange={(e) => set("surprise", Number(e.target.value))}
          />
        </label>
        <Choice label="Moods">{pool("moods", "Moods")}</Choice>
        <div className="direction-grid">
          <label>
            <span>Language</span>
            <input
              className="text-field"
              value={draft.language}
              maxLength={24}
              onChange={(e) => set("language", e.target.value)}
            />
          </label>
          <label>
            <span>Theme</span>
            <input
              className="text-field"
              value={draft.theme}
              maxLength={160}
              placeholder="Optional"
              onChange={(e) => set("theme", e.target.value)}
            />
          </label>
        </div>
        <div className="direction-choices">
          <Choice label="Energy">
            <Segmented
              name="energy"
              label="Energy"
              value={draft.energy}
              onChange={(v) => set("energy", v)}
              options={[
                { value: "any", label: "Any" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </Choice>
          <Choice label="Vocals">
            <Segmented
              name="vocals"
              label="Vocals"
              value={draft.vocals}
              onChange={(v) => set("vocals", v)}
              options={[
                { value: "vocal", label: "Sung" },
                { value: "any", label: "Mixed" },
                { value: "instrumental", label: "Instrumental" },
              ]}
            />
          </Choice>
          <Choice label="Length">
            <span className="muted">
              {clock(draft.lengthMinSeconds)}–{clock(draft.lengthMaxSeconds)}
            </span>
            <input
              type="range"
              aria-label="Shortest song"
              min={radio.lengthLimits.min}
              max={radio.lengthLimits.max}
              step={15}
              value={draft.lengthMinSeconds}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDraft((d) => ({
                  ...d,
                  lengthMinSeconds: v,
                  lengthMaxSeconds: Math.max(v, d.lengthMaxSeconds),
                }));
                setSaved(false);
              }}
            />
            <input
              type="range"
              aria-label="Longest song"
              min={radio.lengthLimits.min}
              max={radio.lengthLimits.max}
              step={15}
              value={draft.lengthMaxSeconds}
              onChange={(e) => {
                const v = Number(e.target.value);
                setDraft((d) => ({
                  ...d,
                  lengthMaxSeconds: v,
                  lengthMinSeconds: Math.min(v, d.lengthMinSeconds),
                }));
                setSaved(false);
              }}
            />
          </Choice>
          <Choice label="Host">
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
          </Choice>
        </div>
        <div className="direction-save">
          <span className="muted">
            {saved ? "Applies to songs not written yet." : "Not applied yet."}
          </span>
          <button
            type="button"
            className="button primary"
            disabled={saved}
            onClick={() => void run(ipc.radioMix(draft))}
          >
            Apply
          </button>
        </div>
        {error && (
          <p className="row-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

const lmLabels: Record<ipc.AceLm, string> = {
  auto: "automatic",
  "0.6b": "0.6B",
  "4b": "4B",
};

/** Which engine makes the songs, with its install and licence. */
function EnginePanel({
  radio,
  onChange,
}: {
  radio: ipc.Radio;
  onChange: (r: ipc.Radio) => void;
}) {
  const { models, error, run } = useMusicModels();
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
  const downloading = rows.some((m) => m.state === "downloading");
  const missing = missingBytes(models, ids);
  const terms = rows.find((m) => m.id === "ace-step-1.5-turbo")?.terms ?? null;
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
  return (
    <details
      className="group radio-direction radio-engine"
      open={models && !ready ? true : undefined}
    >
      <summary>
        <h2>Music engine</h2>
        <span className="muted">
          {ace ? `ACE-Step 1.5 · ${lmLabels[music.aceLm]}` : "YuE2"}
          {models && !ready ? " · not installed" : ""}
        </span>
      </summary>
      <div className="direction-body">
        <div className="direction-choices">
          <Choice label="Engine">
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
          </Choice>
          {ace && (
            <Choice label="Language model">
              <Segmented
                name="ace-lm"
                label="ACE-Step language model"
                value={music.aceLm}
                disabled={choosing}
                onChange={(v) => void choose(music.engine, v)}
                options={[
                  { value: "auto", label: "Automatic" },
                  { value: "0.6b", label: "0.6B" },
                  { value: "4b", label: "4B" },
                ]}
              />
            </Choice>
          )}
        </div>
        {ace ? (
          <p className="muted engine-about">
            ACE-Step makes a song in under a minute on a mid-range graphics
            card. Tested on NVIDIA graphics cards only: on an AMD integrated
            graphics chip it crashed in testing. Automatic takes the 4B language
            model, which follows the lyrics best, when at least 8 GB of graphics
            memory is free, and the faster 0.6B otherwise. The first song after
            installing or updating takes a few minutes longer while the graphics
            card prepares.
          </p>
        ) : (
          <p className="muted engine-about">
            YuE2, the default, makes a song in about its own length on a
            mid-range graphics card. Its licence allows non-commercial use only
            (CC BY-NC 4.0).
          </p>
        )}
        {ace && terms && (
          <div className="engine-terms">
            <p className="muted">
              {terms.credit}. Licence: {terms.name}.{" "}
              <span className="terms-url">{terms.url}</span>
            </p>
            <details className="terms" open={!ready || undefined}>
              <summary>Licence and use</summary>
              <p>{terms.text}</p>
            </details>
          </div>
        )}
        <div className="model-state">
          {downloading ? (
            <>
              <div
                className="bar"
                role="progressbar"
                aria-label="Music engine download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ transform: `scaleX(${percent / 100})` }} />
              </div>
              <span className="model-note tabular">
                {models?.doneBytes ? `${percent}%` : "Starting…"}
              </span>
              <button
                type="button"
                className="button quiet"
                onClick={() => void run(ipc.cancelMusicDownload)}
              >
                Cancel
              </button>
            </>
          ) : ready ? (
            <span className="model-ready">
              <Icon name="check" size={16} />
              Installed. Applies from the next song.
            </span>
          ) : models ? (
            <>
              <span className="model-note">
                {gigabytes(missing)} download, then it works offline
              </span>
              <button
                type="button"
                className="button primary"
                onClick={() => void run(() => ipc.downloadMusicModel(ids))}
              >
                <Icon name="download" size={16} />
                {ace ? "Install ACE-Step" : "Download YuE2"}
              </button>
            </>
          ) : null}
        </div>
        {problem && (
          <p className="row-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </details>
  );
}

function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="choice">
      <span>{label}</span>
      {children}
    </div>
  );
}
