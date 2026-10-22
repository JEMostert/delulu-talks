import { useState } from "react";
import {
  AudioLines,
  Ear,
  Hourglass,
  Mic,
  Puzzle,
  Square,
  Timer,
} from "lucide-react";
import { Alert, RangeField, SettingRow, Toggle } from "../ui";
import type { ListenControls } from "../../hooks/useListen";
import type { ListenStatus } from "../../listening";
import type { AppSettings } from "../../types";
import "../../styles/features/listening.css";

function sessionLine(status: ListenStatus): string {
  const session = status.session;
  if (!session) return "Not listening";
  const owner = session.client === "delulu" ? "you" : session.client;
  switch (session.state) {
    case "starting":
      return "Starting the microphone and speech model…";
    case "paused":
      return "Paused while you dictate";
    case "failed":
      return "Listening stopped after an error";
    case "stopped":
      return "Listening stopped";
    default: {
      const parts = [`Listening for ${owner}`];
      if (session.userSpeaking) parts.push("hearing you");
      else if (session.transcribing) parts.push("transcribing");
      if (session.queued) parts.push(`${session.queued} waiting`);
      parts.push(
        session.waiters
          ? `${session.waiters} agent${session.waiters === 1 ? "" : "s"} waiting`
          : "no agent waiting",
      );
      return parts.join(" · ");
    }
  }
}

/** Persistent listening for coding agents: state, tuning, recent turns, skill. */
export function VoiceListening({
  settings: s,
  listen,
  speechReady,
  saving,
  onSave,
  onAction,
}: {
  settings: AppSettings;
  listen: ListenControls;
  speechReady: boolean;
  saving: boolean;
  onSave: (patch: Partial<AppSettings>) => void;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const { status, active } = listen;
  const session = status.session;
  const [installed, setInstalled] = useState<string[] | null>(null);
  return (
    <>
      <section className="pref-group">
        <h3>Listening</h3>
        <div className="pref-list">
          <div className="voice-listen-head">
            <span
              className={`voice-listen-dot ${active ? "on" : ""} ${session?.userSpeaking ? "speaking" : ""}`}
              aria-hidden="true"
            />
            <div className="setting-copy">
              <strong>{sessionLine(status)}</strong>
              <p>
                Coding agents can keep the microphone open and hear you in
                turns. Delulu stops talking when you talk over it.
              </p>
            </div>
            {active ? (
              <button
                className="secondary-button"
                onClick={() => void onAction(listen.stop, "Stopped listening")}
              >
                <Square /> Stop
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={!speechReady}
                title={
                  speechReady
                    ? undefined
                    : "Set up a speech model in Models first."
                }
                onClick={() => void onAction(listen.start)}
              >
                <Mic /> Start
              </button>
            )}
          </div>
          {!speechReady && !active && (
            <p className="pref-note voice-listen-note">
              Listening uses your speech model. Set it up in Models first.
            </p>
          )}
          {session?.state === "failed" && session.error && (
            <Alert>{session.error}</Alert>
          )}
          <SettingRow
            icon={Ear}
            title="Sensitivity"
            description="Low hears only clear speech; high also quiet speech."
          >
            <RangeField
              label="Listening sensitivity"
              min={0}
              max={1}
              step={0.05}
              value={s.listenSensitivity}
              format={(value) => `${Math.round(value * 100)}%`}
              disabled={saving}
              onCommit={(listenSensitivity) => onSave({ listenSensitivity })}
            />
          </SettingRow>
          <SettingRow
            icon={Hourglass}
            title="Pause before a turn ends"
            description="How long you stay quiet before it is sent."
          >
            <RangeField
              label="Pause before a turn ends"
              min={300}
              max={3000}
              step={100}
              value={s.listenSilenceMs}
              format={(value) => `${(value / 1000).toFixed(1)} s`}
              disabled={saving}
              onCommit={(listenSilenceMs) => onSave({ listenSilenceMs })}
            />
          </SettingRow>
          <SettingRow
            icon={AudioLines}
            title="Stop Delulu when I talk over it"
            description="Headphones give the most reliable interruptions."
          >
            <Toggle
              value={s.listenBargeIn}
              label="Stop Delulu when I talk over it"
              disabled={saving}
              onChange={() => onSave({ listenBargeIn: !s.listenBargeIn })}
            />
          </SettingRow>
          {s.listenBargeIn && (
            <SettingRow
              icon={Timer}
              title="Interrupt after"
              description="Longer ignores coughs and short noises."
            >
              <RangeField
                label="Interrupt after"
                min={100}
                max={1000}
                step={100}
                value={s.listenBargeInMs}
                format={(value) => `${(value / 1000).toFixed(1)} s`}
                disabled={saving}
                onCommit={(listenBargeInMs) => onSave({ listenBargeInMs })}
              />
            </SettingRow>
          )}
          <SettingRow
            icon={Puzzle}
            title="Agent skill"
            description="Teaches the agent the listen → answer → listen loop."
          >
            <button
              className="secondary-button"
              onClick={() =>
                void onAction(async () => {
                  const result = await listen.installSkill();
                  setInstalled(result.paths);
                }, "Skill installed")
              }
            >
              Install skill for Claude Code
            </button>
          </SettingRow>
          {installed && (
            <p className="pref-note voice-listen-note">
              Installed to {installed.join(", ")}
            </p>
          )}
        </div>
      </section>

      <section className="pref-group">
        <h3>Recent turns</h3>
        {status.recent.length === 0 ? (
          <p className="pref-note">
            What you say during a listening session appears here.
          </p>
        ) : (
          <ol className="pref-list voice-recent">
            {status.recent.map((item) => (
              <li key={item.id}>
                <div className="voice-recent-meta">
                  <time dateTime={new Date(item.at).toISOString()}>
                    {new Date(item.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <strong>You</strong>
                  {item.interruptedResponseId && (
                    <span className="badge neutral">
                      Interrupted a response
                    </span>
                  )}
                  <span className="caption">
                    {(item.durationMs / 1000).toFixed(1)} s
                  </span>
                </div>
                <p>{item.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

/** Always-visible badge while a session listens, with a stop button. */
export function ListeningIndicator({ listen }: { listen: ListenControls }) {
  const session = listen.status.session;
  if (!listen.active || !session) return null;
  return (
    <div
      className={`listening-indicator ${session.userSpeaking ? "speaking" : ""}`}
      role="status"
    >
      <span className="voice-listen-dot on" aria-hidden="true" />
      <span>
        {session.state === "paused" ? "Listening paused" : "Listening"}
      </span>
      <button
        className="listening-stop"
        aria-label="Stop listening"
        onClick={() => void listen.stop()}
      >
        <Square aria-hidden="true" /> Stop
      </button>
    </div>
  );
}
