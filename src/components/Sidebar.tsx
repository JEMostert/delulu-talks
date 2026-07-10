import { AudioLines, BookOpenText, Clock3, Home, Settings2, Sparkles } from "lucide-react";
import type { DictationStatus, Page } from "../types";

const items: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "models", label: "Model studio", icon: Sparkles },
  { id: "vocabulary", label: "My vocabulary", icon: BookOpenText },
  { id: "history", label: "History", icon: Clock3 },
];

export function Sidebar({ page, onNavigate, status }: { page: Page; onNavigate: (page: Page) => void; status: DictationStatus }) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onNavigate("home")}>
        <span className="brand-mark"><img src="/delulu-talks-icon.svg" alt="" /></span>
        <span><strong>delulu</strong><small>talks</small></span>
      </button>

      <nav>
        <p className="nav-label">Workspace</p>
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={page === id ? "active" : ""} onClick={() => onNavigate(id)}>
            <Icon /><span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button className={page === "settings" ? "active" : ""} onClick={() => onNavigate("settings")}><Settings2 /><span>Settings</span></button>
        <div className="engine-card">
          <div className="engine-orb"><AudioLines /></div>
          <div><strong>{status.phase === "idle" ? "Ready to listen" : status.phase}</strong><small>{status.message || "Private. Local. Yours."}</small></div>
        </div>
      </div>
    </aside>
  );
}
