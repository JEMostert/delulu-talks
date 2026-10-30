import { useEffect, useRef, useState, type ComponentType } from "react";
import type { AppState } from "../state";
import {
  AboutSection,
  AppearanceSection,
  DictationSection,
  InputSection,
  VoiceSection,
} from "./SettingsSections";

const sections: {
  id: string;
  title: string;
  lead: string;
  Body: ComponentType<{ state: AppState }>;
}[] = [
  {
    id: "input",
    title: "Input",
    lead: "How you start talking.",
    Body: InputSection,
  },
  {
    id: "dictation",
    title: "Dictation",
    lead: "How speech becomes text.",
    Body: DictationSection,
  },
  {
    id: "voice",
    title: "Voice replies",
    lead: "Hear your agent when you ask.",
    Body: VoiceSection,
  },
  {
    id: "appearance",
    title: "Appearance",
    lead: "How it looks.",
    Body: AppearanceSection,
  },
  { id: "about", title: "About", lead: "", Body: AboutSection },
];

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
