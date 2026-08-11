import { AudioLines, BookOpenText, Clock3, Cpu, FlaskConical, Mic2, Settings2 } from "lucide-react";
import type { DictationStatus, Page } from "../types";

const groups: Array<{ label: string; items: Array<{ id: Page; label: string; icon: typeof Mic2 }> }> = [
  {
    label: "Work",
    items: [
      { id: "home", label: "Dictation", icon: Mic2 },
      { id: "lab", label: "Speech Lab", icon: FlaskConical },
      { id: "history", label: "History", icon: Clock3 },
    ],
  },
  {
    label: "Configure",
    items: [
      { id: "vocabulary", label: "Wordbook", icon: BookOpenText },
      { id: "models", label: "Models & runtime", icon: Cpu },
    ],
  },
];

export function Sidebar({ page, onNavigate, status }: { page: Page; onNavigate: (page: Page) => void; status: DictationStatus }) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onNavigate("home")} aria-label="Open Dictation">
        <span className="brand-mark"><img src="/delulu-talks-icon.svg" alt="" /></span>
        <span><strong>Delulu Talks</strong><small>Local voice tools</small></span>
      </button>

      <nav aria-label="Workspace">
        {groups.map((group) => (
          <section className="nav-group" key={group.label}>
            <p className="nav-label">{group.label}</p>
            {group.items.map(({ id, label, icon: Icon }) => (
              <button key={id} className={page === id ? "active" : ""} aria-label={label} aria-current={page === id ? "page" : undefined} title={label} onClick={() => onNavigate(id)}>
                <Icon /><span>{label}</span>
              </button>
            ))}
          </section>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button className={page === "settings" ? "active" : ""} aria-label="Settings" aria-current={page === "settings" ? "page" : undefined} title="Settings" onClick={() => onNavigate("settings")}><Settings2 /><span>Settings</span></button>
        <button className={`engine-summary phase-${status.phase}`} aria-label={`Speech engine: ${status.engine}`} onClick={() => onNavigate("models")} title={status.detail ?? status.message}>
          <AudioLines />
          <span><small>Speech engine</small><strong>{status.engine}</strong></span>
          <i />
        </button>
      </div>
    </aside>
  );
}
