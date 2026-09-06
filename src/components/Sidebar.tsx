import {
  BookOpenText,
  Clock3,
  Cpu,
  FlaskConical,
  House,
  Settings2,
  ShieldCheck,
  WandSparkles,
} from "lucide-react";
import type { DictationStatus, MagicStatus, Page } from "../types";

const groups = [
  {
    label: "Workspace",
    items: [
      { id: "home", label: "Home", icon: House },
      { id: "history", label: "History", icon: Clock3 },
      { id: "magic", label: "Magic", icon: WandSparkles },
    ],
  },
  {
    label: "Make it yours",
    items: [
      { id: "vocabulary", label: "Wordbook", icon: BookOpenText },
      { id: "lab", label: "Speech Lab", icon: FlaskConical },
      { id: "models", label: "Models", icon: Cpu },
    ],
  },
] as const;

export function Sidebar({
  page,
  onNavigate,
  status,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  status: DictationStatus;
  magicStatus: MagicStatus;
}) {
  return (
    <aside className="sidebar">
      <button
        className="brand"
        onClick={() => onNavigate("home")}
        aria-label="Delulu Talks home"
      >
        <span className="brand-mark">
          <img src="./delulu-talks-icon.svg" alt="" />
        </span>
        <span>
          <strong>
            delulu talks<span className="brand-dot">.</span>
          </strong>
          <small>A little more you.</small>
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
        <button
          className={page === "settings" ? "active" : ""}
          aria-current={page === "settings" ? "page" : undefined}
          title="Settings"
          onClick={() => onNavigate("settings")}
        >
          <Settings2 />
          <span>Settings</span>
        </button>
        <div className="privacy-note">
          <ShieldCheck />
          <span>
            Just you and your device.
            <small>
              {status.engine === "ready"
                ? "Local engine ready"
                : "Private by design"}
            </small>
          </span>
        </div>
      </div>
    </aside>
  );
}
