import { AppUpdates } from "../components/AppUpdates";
import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  IconButton,
  Line,
  Segmented,
  Switch,
  Tag,
  tipId,
} from "../components/Controls";
import { Icon, type IconName } from "../components/Icon";
import { errorText, type AppState } from "../state";

/** From package.json, set by Vite. */
declare const __APP_VERSION__: string;

/** App-wide settings only: each feature keeps its own settings on its page. */
export function Settings({ state }: { state: AppState }) {
  const { settings, status, update, setNotice } = state;
  const [licences, setLicences] = useState(false);
  if (!settings || !status) return null;
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Settings</h1>
      </header>
      <div className="cards">
        <section className="glass-card" aria-labelledby="settings-app">
          <h2 id="settings-app" className="card-label">
            App
          </h2>
          <Line label="Theme">
            <Segmented
              name="theme"
              label="Theme"
              value={settings.theme}
              onChange={(value) => void update("theme", value)}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Line>
          {!ipc.isMac && (
            <Line
              label="Start at login"
              htmlFor="login"
              tip="Starts hidden in the tray when you log in"
            >
              <Switch
                id="login"
                checked={settings.startAtLogin}
                describedBy={tipId("login")}
                onChange={(value) => void update("startAtLogin", value)}
              />
            </Line>
          )}
        </section>
        <section className="glass-card" aria-labelledby="settings-features">
          <h2 id="settings-features" className="card-label">
            Features
          </h2>
          <Line
            label={<FeatureLabel icon="radio" text="Delulu FM" />}
            htmlFor="feature-radio"
            tip="A radio station made on this computer. Needs a music model and a graphics card; nothing plays until you press Play."
          >
            <Switch
              id="feature-radio"
              checked={settings.radio}
              describedBy={tipId("feature-radio")}
              onChange={(value) => void update("radio", value)}
            />
          </Line>
          <Line
            label={<FeatureLabel icon="cleanup" text="Cleanup" />}
            htmlFor="feature-cleanup"
            tip="Tidies each dictation and uses your vocabulary, on this computer"
          >
            <Switch
              id="feature-cleanup"
              checked={settings.cleanup}
              describedBy={tipId("feature-cleanup")}
              onChange={(value) => void update("cleanup", value)}
            />
          </Line>
        </section>
        <section className="glass-card" aria-labelledby="settings-about">
          <h2 id="settings-about" className="card-label">
            About
          </h2>
          <Line label="Version">
            <span className="line-value tabular">{__APP_VERSION__}</span>
            <IconButton
              icon="external"
              label="Project page"
              onClick={() =>
                void ipc.openProjectPage().catch((e) => setNotice(errorText(e)))
              }
            />
          </Line>
          <AppUpdates />
          <Line label="Runs on" tip="Where speech recognition runs">
            <span className="line-value">
              {status.backend ?? "Not loaded yet"}
            </span>
          </Line>
          <Line label="Data">
            <span className="line-value data-path" data-tip={status.dataDir}>
              {homePath(status.dataDir)}
            </span>
            <IconButton
              icon="folder"
              label="Open data folder"
              onClick={() =>
                void ipc
                  .openFolder(status.dataDir)
                  .catch((e) => setNotice(errorText(e)))
              }
            />
          </Line>
          <Line label="Licences">
            <button
              type="button"
              className="button quiet small"
              aria-haspopup="dialog"
              onClick={() => setLicences(true)}
            >
              View
            </button>
          </Line>
        </section>
      </div>
      {licences && <LicencesDialog onClose={() => setLicences(false)} />}
    </div>
  );
}

/** "/home/ann/.local/share/x" → "~/.local/share/x", for display only. */
const homePath = (path: string) =>
  path.replace(/^\/(home\/[^/]+|root)(?=\/)/, "~");

function FeatureLabel({ icon, text }: { icon: IconName; text: string }) {
  return (
    <span className="feature-label">
      <Icon name={icon} size={15} />
      {text}
    </span>
  );
}

type Licence = {
  model: string;
  credit: string;
  name: string;
  url: string | null;
  /** Terms the app shows before a download. */
  text?: string;
  /** A duty that goes with it, as a small tag; the tip says more. */
  duty?: { tag: string; tip: string };
};
type LicenceGroup = { title: string; rows: Licence[] };

const SUPERTONIC_URL =
  "https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE";
const AI_VOICE = {
  tag: "AI-generated voice",
  tip: "Use restrictions apply to everything the voices say. Say the audio is machine generated wherever you share it.",
};
const NON_COMMERCIAL = {
  tag: "Non-commercial",
  tip: "Songs made with it may not be used commercially",
};

/** The voice model's credit, also when the voice command cannot be asked. */
const voiceFallback: Licence = {
  model: "Supertonic 3",
  credit: "Supertonic 3 by Supertone Inc.",
  name: "BigScience OpenRAIL-M",
  url: SUPERTONIC_URL,
  duty: AI_VOICE,
};
/** Music credits, also when the music models cannot be listed. */
const musicFallback: Licence[] = [
  {
    model: "YuE2 3B",
    credit: "YuE2 by M-A-P",
    name: "CC BY-NC 4.0",
    url: "https://huggingface.co/m-a-p/YuE2-3B",
    duty: NON_COMMERCIAL,
  },
  {
    model: "ACE-Step 1.5",
    credit: "ACE-Step 1.5 by ACE Studio and StepFun",
    name: "MIT (text encoder: Apache-2.0)",
    url: "https://huggingface.co/Serveurperso/ACE-Step-1.5-GGUF",
  },
];

function speechRows(models: ipc.ModelStatus[]): Licence[] {
  return models.map((m) => {
    const whisper = m.engine === "whisper";
    const label = m.label.replace(/\s*\(.*\)$/, "");
    return {
      model: whisper ? `Whisper ${label}` : label,
      credit: m.credit ?? (whisper ? "Whisper by OpenAI" : ""),
      name: m.license,
      url:
        m.licenseUrl ??
        (whisper
          ? "https://github.com/openai/whisper/blob/main/LICENSE"
          : null),
    };
  });
}

function musicRows(music: ipc.MusicModel): Licence[] {
  return music.models.map((m) =>
    m.engine === "yue"
      ? { ...musicFallback[0], model: m.label, name: m.license }
      : {
          model: m.label,
          credit: m.terms?.credit ?? musicFallback[1].credit,
          name: m.terms?.name ?? m.license,
          url: m.terms?.url ?? musicFallback[1].url,
          text: m.terms?.text,
        },
  );
}

function voiceRow(voice: ipc.VoiceStatus): Licence {
  return {
    model: voice.modelLabel,
    credit: voice.terms.credit,
    name: voice.terms.name,
    url: voice.terms.url,
    text: voice.terms.text,
    duty: AI_VOICE,
  };
}

async function loadLicences(): Promise<LicenceGroup[]> {
  const [speech, voice, music] = await Promise.allSettled([
    ipc.listModels(),
    ipc.getVoiceStatus(),
    ipc.getMusicModel(),
  ]);
  return [
    {
      title: "App",
      rows: [
        {
          model: "Delulu Talks",
          credit: "The Delulu Talks authors",
          name: "MIT",
          url: "https://github.com/JEMostert/delulu-talks/blob/master/LICENSE",
        },
        {
          model: "Silero VAD",
          credit: "Silero Team, speech detection built into the engine",
          name: "MIT",
          url: "https://github.com/snakers4/silero-vad",
        },
      ],
    },
    {
      title: "Speech",
      rows: speech.status === "fulfilled" ? speechRows(speech.value) : [],
    },
    {
      title: "Cleanup",
      rows: [
        {
          model: "Gemma 4 E4B",
          credit: "Gemma 4 by Google",
          name: "Apache-2.0",
          url: "https://ai.google.dev/gemma/docs/gemma_4_license",
        },
      ],
    },
    {
      title: "Voice",
      rows: [
        voice.status === "fulfilled" ? voiceRow(voice.value) : voiceFallback,
      ],
    },
    {
      title: "Music",
      rows:
        music.status === "fulfilled" ? musicRows(music.value) : musicFallback,
    },
  ].filter((group) => group.rows.length > 0);
}

/** Every model's licence and credit, in a dialog over the page. */
function LicencesDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [groups, setGroups] = useState<LicenceGroup[]>();
  const [open, setOpen] = useState<string>();
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    let active = true;
    void loadLicences().then((value) => {
      if (active) setGroups(value);
    });
    return () => {
      active = false;
      node?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="glass app-dialog licences"
      aria-labelledby="licences-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="app-dialog-head">
        <h2 id="licences-title">Licences</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className="app-dialog-body">
        {!groups && <p className="line-note">Loading…</p>}
        {groups?.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="card-label">{group.title}</h3>
            <ul className="licence-list">
              {group.rows.map((row) => {
                const key = `${group.title}-${row.model}`;
                return (
                  <li key={key}>
                    <div className="licence-row">
                      <span className="licence-model">{row.model}</span>
                      <span className="licence-credit" data-tip={row.credit}>
                        {row.credit}
                      </span>
                      {row.duty && (
                        <Tag tone="warn" tip={row.duty.tip}>
                          {row.duty.tag}
                        </Tag>
                      )}
                      {row.url ? (
                        <button
                          type="button"
                          className="tag plain tag-button"
                          data-tip={row.url}
                          onClick={() =>
                            void ipc.openLicence(row.url!).catch(() => {})
                          }
                        >
                          {row.name}
                          <Icon name="external" size={12} />
                        </button>
                      ) : (
                        <Tag tone="plain">{row.name}</Tag>
                      )}
                      {row.text && (
                        <IconButton
                          icon="chevron"
                          label={`${open === key ? "Hide" : "Show"} terms of ${row.model}`}
                          size={15}
                          onClick={() =>
                            setOpen(open === key ? undefined : key)
                          }
                        />
                      )}
                    </div>
                    {row.text && open === key && (
                      <p className="licence-text">{row.text}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  );
}
