import {
  ArrowRight,
  AudioLines,
  ClipboardPaste,
  Cpu,
  Mic,
  ShieldCheck,
  Sparkles,
  Square,
} from "lucide-react";
import { LANGUAGES } from "../data";
import {
  TranscriptCard,
  type TranscriptActions,
} from "../components/TranscriptCard";
import type {
  AppSettings,
  DictationStatus,
  Page,
  ShortcutStatus,
  TranscriptRecord,
} from "../types";

export function HomePage({
  settings,
  status,
  shortcutStatus,
  history,
  saving,
  onNavigate,
  onUpdateSettings,
  onRecord,
  onPasteLast,
  ...actions
}: TranscriptActions & {
  settings: AppSettings;
  status: DictationStatus;
  shortcutStatus: ShortcutStatus;
  history: TranscriptRecord[];
  saving: boolean;
  onNavigate: (page: Page) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onRecord: () => void;
  onPasteLast: () => void;
}) {
  const recording = status.phase === "listening";
  const busy = ["preparing", "loading", "transcribing"].includes(status.phase);
  const missing = status.engine === "missing" || status.engine === "error";
  const hold =
    settings.shortcutMode === "hold" && shortcutStatus.method === "portal";
  return (
    <div className="home-view content-stack">
      <section className={`dictation-hero ${recording ? "is-recording" : ""}`}>
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="status-dot" /> YOUR VOICE, YOUR SPACE
          </span>
          <h2>
            {recording
              ? "Go on. I’m listening."
              : busy
                ? "A little moment for your words."
                : "Less typing.\nMore you."}
          </h2>
          <p>
            {missing
              ? "Let’s get your local speech engine ready. Then your voice can go wherever you type."
              : recording
                ? "Speak naturally. Stop when you’re ready and your words will be transcribed on this device."
                : "A thought, a message, a beautifully messy idea.\nJust say it. We’ll take care of the words."}
          </p>
          <div className="hero-actions">
            <button
              className="primary-button large"
              disabled={busy}
              onClick={missing ? () => onNavigate("models") : onRecord}
            >
              {missing ? <Cpu /> : recording ? <Square /> : <Mic />}
              {missing
                ? "Set up dictation"
                : recording
                  ? "Finish recording"
                  : "Start talking"}
            </button>
            {!missing && (
              <span className="shortcut-instruction">
                or {hold ? "hold" : "press"}{" "}
                <kbd>
                  {settings.shortcut
                    .replace("Super", "Meta")
                    .replace("CommandOrControl", "Ctrl")
                    .split("+")
                    .join(" + ")}
                </kbd>
              </span>
            )}
          </div>
        </div>
        <div className="voice-art" aria-hidden="true">
          <div className="voice-orbit">
            <AudioLines />
          </div>
          <div className="voice-wave">
            {[18, 30, 52, 38, 72, 92, 62, 42, 68, 32, 18].map((height, i) => (
              <i key={i} style={{ height, animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
          <span>Made for your train of thought.</span>
        </div>
      </section>
      <div className="preference-strip">
        <label>
          <span>Speaking in</span>
          <select
            aria-label="Dictation language"
            disabled={saving}
            value={settings.language}
            onChange={(e) => onUpdateSettings({ language: e.target.value })}
          >
            {LANGUAGES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <Sparkles />
          <span>Writing style</span>
          <select
            aria-label="Dictation writing style"
            disabled={saving}
            value={settings.magicEnabled ? settings.magicPreset : "plain"}
            onChange={(e) =>
              onUpdateSettings(
                e.target.value === "plain"
                  ? { magicEnabled: false }
                  : {
                      magicEnabled: true,
                      magicPreset: e.target.value as AppSettings["magicPreset"],
                    },
              )
            }
          >
            <option value="plain">Plain transcript</option>
            <option value="polish">Polished</option>
            <option value="concise">Concise</option>
            <option value="structured">Structured</option>
            <option value="prompt">Prompt builder</option>
          </select>
        </label>
        <span className="local-label">
          <ShieldCheck /> Processed on your device
        </span>
      </div>
      <section className="content-stack">
        <div className="section-heading">
          <div>
            <span className="eyebrow">YOUR WORDS, WITHIN REACH</span>
            <h3>Recent activity</h3>
          </div>
          <div className="panel-actions">
            {history.length > 0 && (
              <button className="tool-button" onClick={onPasteLast}>
                <ClipboardPaste /> Paste last
              </button>
            )}
            <button
              className="text-button"
              onClick={() => onNavigate("history")}
            >
              View history <ArrowRight />
            </button>
          </div>
        </div>
        {history.length ? (
          history
            .slice(0, 3)
            .map((record) => (
              <TranscriptCard key={record.id} record={record} {...actions} />
            ))
        ) : (
          <div className="first-recording">
            <span className="empty-icon">
              <Mic />
            </span>
            <div>
              <h3>Your next thought belongs here</h3>
              <p>
                Try a short recording. You can review, edit, and copy every
                result.
              </p>
            </div>
          </div>
        )}
      </section>
      <div className="home-links">
        <button onClick={() => onNavigate("vocabulary")}>
          <span>Names it should know</span>
          <strong>
            Make your words feel familiar <ArrowRight />
          </strong>
        </button>
        <button onClick={() => onNavigate("magic")}>
          <span>Something already on your mind?</span>
          <strong>
            Give a rough draft a little polish <ArrowRight />
          </strong>
        </button>
      </div>
    </div>
  );
}
