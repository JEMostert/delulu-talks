import { useEffect, useRef, useState, type ComponentType } from "react";
import type { AppState } from "../state";
import {
  AboutSection,
  AppearanceSection,
  ModelsSection,
  RadioSection,
  VoiceSection,
} from "./SettingsSections";

type Section = {
  id: string;
  title: string;
  lead: string;
  Body: ComponentType<{ state: AppState }>;
};

// Dictation's settings live on Dictate. Voice and Models have their own pages
// in the rail until they get their own screens.
const sections: Section[] = [
  {
    id: "appearance",
    title: "App",
    lead: "",
    Body: AppearanceSection,
  },
  {
    id: "radio",
    title: "Delulu FM",
    lead: "",
    Body: RadioSection,
  },
  { id: "about", title: "About", lead: "", Body: AboutSection },
];

/** A page made of one settings section, under its own heading. */
export function SettingsPage({
  state,
  title,
  Body,
}: {
  state: AppState;
  title: string;
  Body: ComponentType<{ state: AppState }>;
}) {
  return (
    <div className="settings settings-single">
      <div className="settings-scroll">
        <h1>{title}</h1>
        <section className="settings-section" aria-label={title}>
          <Body state={state} />
        </section>
      </div>
    </div>
  );
}

export const VoicePage = ({ state }: { state: AppState }) => (
  <SettingsPage state={state} title="Voice" Body={VoiceSection} />
);
export const ModelsPage = ({ state }: { state: AppState }) => (
  <SettingsPage state={state} title="Models" Body={ModelsSection} />
);

export function Settings({ state }: { state: AppState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(sections[0].id);

  // Mark the section whose heading most recently scrolled past the top.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 96;
      const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      let current = sections[0].id;
      for (const { id } of sections) {
        const el = document.getElementById(`settings-${id}`);
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      setActive(atEnd ? sections[sections.length - 1].id : current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);

  const jump = (id: string) => {
    setActive(id);
    document
      .getElementById(`settings-${id}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="settings">
      <nav className="settings-index" aria-label="Settings sections">
        <h1>Settings</h1>
        <ul>
          {sections.map(({ id, title }) => (
            <li key={id}>
              <button
                type="button"
                aria-current={active === id ? "true" : undefined}
                onClick={() => jump(id)}
              >
                {title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-scroll" ref={scroller}>
        {sections.map(({ id, title, lead, Body }) => (
          <section
            key={id}
            id={`settings-${id}`}
            className="settings-section"
            aria-labelledby={`settings-${id}-title`}
          >
            <div className="section-head">
              <h2 id={`settings-${id}-title`}>{title}</h2>
              {lead && <p>{lead}</p>}
            </div>
            <Body state={state} />
          </section>
        ))}
      </div>
    </div>
  );
}
