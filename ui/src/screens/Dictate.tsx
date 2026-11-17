import * as ipc from "../ipc";
import { insertMessage, languageName, toggleLanguage } from "../helpers";
import { CleanupLine } from "../components/CleanupControl";
import {
  IconButton,
  Keys,
  Line,
  Select,
  Switch,
  tipId,
} from "../components/Controls";
import { Hero } from "../components/Hero";
import { HistoryPanel } from "../components/HistoryPanel";
import { Icon } from "../components/Icon";
import { ModelLines } from "../components/ModelControl";
import { errorText, type AppState } from "../state";

/** Dictation: the pearl and every dictation setting, beside the full history. */
export function Dictate({ state }: { state: AppState }) {
  const { status, level, recovery, setRecovery, copy, setNotice } = state;
  if (!status) return null;
  const changeHotkey = () =>
    void ipc
      .changeHotkey()
      .then(() =>
        setNotice(
          "Pick a new key in the window that opened, or in your system’s shortcut settings.",
        ),
      )
      .catch((e) => setNotice(errorText(e)));
  return (
    <div className="dictate">
      <div className="dictate-side">
        <Hero
          status={status}
          level={level}
          recovery={recovery}
          onHotkey={changeHotkey}
        />
        {recovery?.insert.kind === "failed" && (
          <div className="recovery" role="alert">
            <div className="recovery-head">
              <Icon name="alert" size={16} />
              <span data-tip={insertMessage(recovery.insert)}>
                Not inserted
              </span>
              <IconButton
                icon="copy"
                label="Copy text"
                onClick={() => void copy(recovery.entry.text)}
              />
              <IconButton
                icon="close"
                label="Dismiss"
                onClick={() => setRecovery(undefined)}
              />
            </div>
            <p className="recovery-text">{recovery.entry.text}</p>
            <span className="visually-hidden">
              {insertMessage(recovery.insert)}
            </span>
          </div>
        )}
        <DictateSettings state={state} onHotkey={changeHotkey} />
      </div>
      <HistoryPanel state={state} />
    </div>
  );
}

function DictateSettings({
  state,
  onHotkey,
}: {
  state: AppState;
  onHotkey: () => void;
}) {
  const {
    settings,
    status,
    microphones,
    languages,
    models,
    update,
    cleanupStatus,
    setNotice,
    navigate,
    modelProps,
  } = state;
  if (!settings || !status) return null;
  const parakeet =
    models.find((m) => m.id === settings.model)?.engine === "parakeet";
  const languageTip = parakeet
    ? "Parakeet hears the language itself; a fixed one guides cleanup"
    : settings.language === "auto"
      ? "Picks whichever of your languages you speak"
      : "Every dictation is heard as this language";
  return (
    <section
      className="glass-card dictate-settings"
      aria-label="Dictation settings"
    >
      <Line label="Hotkey">
        {status.hotkey.error && (
          <span
            className="line-alert"
            role="img"
            aria-label={status.hotkey.error}
            data-tip={status.hotkey.error}
          >
            <Icon name="alert" size={16} />
          </span>
        )}
        <Keys trigger={status.hotkey.trigger} small />
        <IconButton icon="edit" label="Change hotkey" onClick={onHotkey} />
      </Line>
      <Line label="Microphone" htmlFor="dictate-mic">
        <Select
          id="dictate-mic"
          value={settings.microphone ?? ""}
          onChange={(value) => void update("microphone", value || null)}
        >
          <option value="">System default</option>
          {microphones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.isDefault ? " (default)" : ""}
            </option>
          ))}
        </Select>
      </Line>
      <ModelLines {...modelProps} onModels={() => navigate("Models")} />
      <Line label="Language" htmlFor="dictate-language" tip={languageTip}>
        <Select
          id="dictate-language"
          value={settings.language}
          describedBy={tipId("dictate-language")}
          onChange={(value) => void update("language", value)}
        >
          <option value="auto">Automatic</option>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {languageName(l.code, languages)}
            </option>
          ))}
        </Select>
      </Line>
      {settings.language === "auto" && !parakeet && (
        <YourLanguages state={state} />
      )}
      <CleanupLine
        status={cleanupStatus}
        enabled={settings.cleanup}
        onToggle={(value) => void update("cleanup", value)}
        onError={(e) => setNotice(errorText(e))}
      />
      <Line
        label="Smart context"
        htmlFor="dictate-context"
        tip="Remembers what you were just talking about, so names and terms come out right. Forgotten after 10 quiet minutes."
      >
        <Switch
          id="dictate-context"
          checked={settings.smartContext}
          describedBy={tipId("dictate-context")}
          onChange={(value) => void update("smartContext", value)}
        />
      </Line>
      <Line
        label="Paste with"
        htmlFor="dictate-insert"
        tip="The keys used to paste into the app you’re in"
      >
        <Select
          id="dictate-insert"
          value={settings.insert}
          describedBy={tipId("dictate-insert")}
          onChange={(value) =>
            void update("insert", value as ipc.Settings["insert"])
          }
        >
          <option value="shift-insert">Shift+Insert</option>
          <option value="ctrl-v">Ctrl+V</option>
          <option value="ctrl-shift-v">Ctrl+Shift+V</option>
          <option value="off">Copy only</option>
        </Select>
      </Line>
      <Line
        label="Recording pill"
        htmlFor="dictate-pill"
        tip="A small pearl at the bottom of the screen while you dictate"
      >
        <Switch
          id="dictate-pill"
          checked={settings.overlay}
          describedBy={tipId("dictate-pill")}
          onChange={(value) => void update("overlay", value)}
        />
      </Line>
    </section>
  );
}

/** The languages Automatic may pick from, so a short or quiet phrase can't come
 * out as a language the user never speaks. Parakeet can't be limited. */
function YourLanguages({ state }: { state: AppState }) {
  const { settings, update, languages } = state;
  if (!settings) return null;
  const allowed = settings.allowedLanguages;
  const set = (code: string) =>
    void update("allowedLanguages", toggleLanguage(allowed, code));
  return (
    <Line
      label="Your languages"
      htmlFor="dictate-add-language"
      tip="Automatic only chooses from these"
    >
      <ul className="lang-set" aria-label="Your languages">
        {allowed.map((code) => {
          const name = languageName(code, languages);
          return (
            <li key={code} className="tag plain" data-tip={name}>
              <span aria-hidden="true">{code.toUpperCase()}</span>
              <span className="visually-hidden">{name}</span>
              {allowed.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  data-tip={`Remove ${name}`}
                  onClick={() => set(code)}
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <Select
        id="dictate-add-language"
        value=""
        label="Add a language"
        describedBy={tipId("dictate-add-language")}
        onChange={(code) => code && set(code)}
      >
        <option value="">+</option>
        {languages
          .filter((l) => !allowed.includes(l.code))
          .map((l) => (
            <option key={l.code} value={l.code}>
              {languageName(l.code, languages)}
            </option>
          ))}
      </Select>
    </Line>
  );
}
