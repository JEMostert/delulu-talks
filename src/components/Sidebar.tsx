import {
  AudioLines,
  BookOpenText,
  Clock3,
  Cpu,
  Settings2,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";
import type { DictationStatus, MagicStatus, Page } from "../types";
const groups = [
  {
    label: "Configure",
    items: [
      { id: "home", label: "Controls", icon: SlidersHorizontal },
      { id: "settings", label: "Settings", icon: Settings2 },
      { id: "models", label: "Models", icon: Cpu },
    ],
  },
  {
    label: "Tools",
    items: [
      { id: "magic", label: "Writing", icon: WandSparkles },
      { id: "history", label: "History", icon: Clock3 },
      { id: "vocabulary", label: "Wordbook", icon: BookOpenText },
      { id: "lab", label: "Audio files", icon: AudioLines },
    ],
  },
] as const;
export function Sidebar({
  page,
  onNavigate,
  status,
  magicStatus,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  status: DictationStatus;
  magicStatus: MagicStatus;
}) {
  const label = (engine: DictationStatus["engine"]) =>
    ({
      ready: "Loaded",
      unloaded: "On demand",
      missing: "Not installed",
      error: "Error",
      loading: "Loading",
      settingUp: "Installing",
    })[engine];
  return (
    <aside className="sidebar">
      <button
        className="brand"
        onClick={() => onNavigate("home")}
        aria-label="Delulu Talks controls"
      >
        <img src="./delulu-talks-icon.svg" alt="" />
        <span>
          <strong>DELULU</strong>
          <small>TALKS</small>
        </span>
      </button>
      <nav aria-label="Workspace">
        {groups.map((group) => (
          <section className="nav-group" key={group.label}>
            <p className="nav-label">{group.label}</p>
            {group.items.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={page === id ? "active" : ""}
                aria-current={page === id ? "page" : undefined}
                title={label}
                onClick={() => onNavigate(id)}
              >
                <Icon />
                <span>{label}</span>
              </button>
            ))}
          </section>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <p className="nav-label">Local engines</p>
        <button
          className="engine-nav"
          onClick={() => onNavigate("models")}
          title={status.message}
        >
          <span
            className={`engine-indicator ${status.engine === "ready" ? "ready" : ""}`}
          />
          <span>
            Speech<small>{label(status.engine)}</small>
          </span>
        </button>
        <button
          className="engine-nav"
          onClick={() => onNavigate("magic")}
          title={magicStatus.message}
        >
          <span
            className={`engine-indicator ${magicStatus.engine === "ready" ? "ready" : ""}`}
          />
          <span>
            Writing<small>{label(magicStatus.engine)}</small>
          </span>
        </button>
        <span className="local-footnote">Processing on this device</span>
      </div>
    </aside>
  );
}
