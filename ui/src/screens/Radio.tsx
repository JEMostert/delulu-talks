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
import { clock, makingText, radioPresets, readinessSteps } from "../radio";

type View = { radio: ipc.Radio; at: number };

export function Radio({ state }: { state: AppState }) {
  const { setNotice, copy } = state;
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
  const steps = readinessSteps(radio.readiness);
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
          command={radio.readiness.installCommand}
          checking={checking}
          onCheck={() => void check()}
          onCopy={copy}
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
      <DirectionPanel radio={radio} onChange={apply} />
    </div>
  );
}

function TitleBlock() {
  return (
    <div className="title-block">
      <h1>Delulu FM</h1>
      <p className="lead">
        A radio station made on this computer. Every song is new: the cleanup
        model writes it, YuE2 composes it in your ComfyUI, and the host speaks
        between songs.
      </p>
    </div>
  );
}

function Readiness({
  steps,
  command,
  checking,
  onCheck,
  onCopy,
}: {
  steps: ReturnType<typeof readinessSteps>;
  command: string;
  checking: boolean;
  onCheck: () => void;
  onCopy: (text: string) => void;
}) {
  // Only offer the download once a running ComfyUI says the model is missing.
  const missingCheckpoint = steps.some(
    (s) => s.id === "checkpoint" && !s.ok && !s.unknown,
  );
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
      {missingCheckpoint && (
        <div className="radio-command">
          <code>{command}</code>
          <button
            type="button"
            className="button quiet"
            onClick={() => onCopy(command)}
          >
            <Icon name="copy" size={16} /> Copy
          </button>
        </div>
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
  const text = item?.kind === "break" ? item.script : item?.lyrics;
  return (
    <section className="group radio-words" aria-labelledby="radio-words-title">
      <h2 id="radio-words-title">
        {item?.kind === "break" ? "The host says" : "Lyrics"}
      </h2>
      {text ? (
        <p className="words">{text}</p>
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

function DirectionPanel({
  radio,
  onChange,
}: {
  radio: ipc.Radio;
  onChange: (r: ipc.Radio) => void;
}) {
  const [draft, setDraft] = useState(radio.direction);
  const [genres, setGenres] = useState(radio.direction.genres.join(", "));
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState<string>();
  const set = <K extends keyof ipc.RadioDirection>(
    key: K,
    value: ipc.RadioDirection[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };
  const save = async (direction: ipc.RadioDirection) => {
    try {
      const r = await ipc.radioDirection(direction);
      onChange(r);
      setDraft(r.direction);
      setGenres(r.direction.genres.join(", "));
      setSaved(true);
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const withGenres = (): ipc.RadioDirection => ({
    ...draft,
    genres: genres
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  });
  return (
    <details className="group radio-direction">
      <summary>
        <h2>Direction</h2>
        <span className="muted">
          {radio.direction.mood} ·{" "}
          {radio.direction.genres.join(", ") || "any style"}
        </span>
      </summary>
      <div className="direction-body">
        <div className="presets" role="group" aria-label="Presets">
          {radioPresets.map((p) => (
            <button
              key={p.name}
              type="button"
              className="button"
              onClick={() => {
                const next = { ...draft, ...p.direction };
                setDraft(next);
                setGenres(next.genres.join(", "));
                void save(next);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="direction-grid">
          <label>
            <span>Mood</span>
            <input
              className="text-field"
              value={draft.mood}
              maxLength={80}
              onChange={(e) => set("mood", e.target.value)}
            />
          </label>
          <label>
            <span>Styles</span>
            <input
              className="text-field"
              value={genres}
              placeholder="soul, jazz"
              onChange={(e) => {
                setGenres(e.target.value);
                setSaved(false);
              }}
            />
          </label>
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
                { value: "either", label: "Mixed" },
                { value: "instrumental", label: "Instrumental" },
              ]}
            />
          </Choice>
          <Choice label="Length">
            <Segmented
              name="length"
              label="Length"
              value={draft.length}
              onChange={(v) => set("length", v)}
              options={[
                { value: "short", label: "Short" },
                { value: "medium", label: "Medium" },
                { value: "long", label: "Long" },
              ]}
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
            onClick={() => void save(withGenres())}
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

function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="choice">
      <span>{label}</span>
      {children}
    </div>
  );
}
