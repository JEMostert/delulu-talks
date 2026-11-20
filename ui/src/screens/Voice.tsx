import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import { IconButton, Line, Select, Tag, tipId } from "../components/Controls";
import { Icon } from "../components/Icon";
import { speakCommand } from "../helpers";
import { errorText, type AppState } from "../state";

/** "F1" → "Female 1", "M3" → "Male 3". */
export function voiceLabel(voice: string) {
  const kind = voice.startsWith("F") ? "Female" : "Male";
  return `${kind} ${voice.slice(1)}`;
}

/**
 * Agents' spoken replies: which voice `delulu speak` uses, and the command to
 * try it. The app cannot speak a text itself, so nothing here plays audio.
 * The voice model is installed on the Models page; the radio host's voice is
 * set on Delulu FM.
 */
export function Voice({ state }: { state: AppState }) {
  const { navigate, setNotice, copy } = state;
  const [status, setStatus] = useState<ipc.VoiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("The build finished.");

  const refresh = useCallback(async () => {
    try {
      setStatus(await ipc.getVoiceStatus());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // An install started on the Models page: follow it until it ends.
  useEffect(() => {
    if (!status?.installing) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.installing, refresh]);

  const choose = (voice: string) =>
    void ipc
      .setVoice("agent", voice)
      .then(refresh)
      .catch((e) => setNotice(errorText(e)));

  const command = speakCommand(
    text,
    ipc.isMac
      ? '"/Applications/Delulu Talks.app/Contents/MacOS/delulu"'
      : "delulu",
  );
  const ready = Boolean(status?.ready && !status.installing);
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Voice</h1>
        <VoiceTag
          status={status}
          error={error}
          onRetry={() => void refresh()}
          onModels={() => navigate("Models")}
        />
      </header>
      <div className="cards">
        <section className="glass-card" aria-labelledby="voice-agent">
          <h2 id="voice-agent" className="card-label">
            Agent voice
          </h2>
          <Line
            label="Spoken replies"
            tip="Agents speak short replies aloud with delulu speak, in Dutch or English, on this computer"
          >
            {ready ? (
              <Tag tone="ok">On</Tag>
            ) : (
              <Tag tone="plain" tip="Needs the voice model">
                Off
              </Tag>
            )}
          </Line>
          <Line label="Voice" htmlFor="agent-voice" tip="An AI-generated voice">
            <Select
              id="agent-voice"
              value={status?.voice ?? ""}
              disabled={!status?.model}
              describedBy={tipId("agent-voice")}
              onChange={choose}
            >
              {(status?.voices ?? []).map((v) => (
                <option key={v} value={v}>
                  {voiceLabel(v)}
                </option>
              ))}
            </Select>
          </Line>
          <Line label="Model">
            <span className="line-value">{status?.modelLabel ?? "…"}</span>
            <IconButton
              icon="box"
              label="Open Models"
              onClick={() => navigate("Models")}
            />
          </Line>
        </section>
        <section className="glass-card" aria-labelledby="voice-try">
          <h2 id="voice-try" className="card-label">
            Try it
          </h2>
          <div className="try">
            <label className="visually-hidden" htmlFor="voice-text">
              Text to speak
            </label>
            <textarea
              id="voice-text"
              className="try-text"
              rows={3}
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div
              className="try-command"
              data-tip="Run it in a terminal; agents use the same command"
            >
              <code>{command}</code>
              <IconButton
                icon="copy"
                label="Copy command"
                size={15}
                onClick={() => void copy(command)}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The voice model's state; when it is missing, a way to the Models page. */
function VoiceTag({
  status,
  error,
  onRetry,
  onModels,
}: {
  status: ipc.VoiceStatus | null;
  error: string | null;
  onRetry: () => void;
  onModels: () => void;
}) {
  if (!status && error)
    return (
      <>
        <Tag tone="warn" tip={error}>
          Unavailable
        </Tag>
        <IconButton icon="history" label="Check again" onClick={onRetry} />
      </>
    );
  if (!status) return <Tag tone="plain">Checking</Tag>;
  if (status.installing) return <Tag>Installing</Tag>;
  if (!status.model)
    return (
      <button
        type="button"
        className="tag warn tag-button"
        data-tip={`Install ${status.modelLabel} on the Models page`}
        onClick={onModels}
      >
        Voice model missing
        <Icon name="chevron" size={12} />
      </button>
    );
  if (!status.engine)
    return (
      <Tag
        tone="warn"
        tip="The voice engine is missing. Reinstall Delulu Talks."
      >
        Engine missing
      </Tag>
    );
  return (
    <Tag tone="ok" tip={`Voice model: ${status.modelLabel}`}>
      Ready
    </Tag>
  );
}
