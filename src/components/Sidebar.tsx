import {
  AudioLines,
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
    <aside className="sidebar flex flex-col bg-[linear-gradient(170deg,rgba(16,58,96,0.78),rgba(7,22,40,0.82))] border-r border-white/10 px-3 pt-[22px] pb-4 text-[#d5e8f7] shadow-[inset_-1px_0_0_rgba(255,255,255,0.06)] backdrop-blur-2xl max-[900px]:px-[9px] max-[900px]:pt-[18px] max-[900px]:pb-3">
      <button
        className="brand flex items-center gap-2.5 border-0 bg-transparent px-2 text-left mb-[30px] text-[#eff9ff] max-[900px]:gap-[7px] max-[900px]:px-[5px] max-[900px]:mb-6 max-[700px]:justify-center max-[700px]:p-0"
        onClick={() => onNavigate("home")}
        aria-label="Delulu Talks controls"
      >
        <img
          src="./delulu-talks-icon.svg"
          alt=""
          className="h-[43px] w-[43px] max-[900px]:h-[35px] max-[900px]:w-[35px]"
        />
        <span className="max-[700px]:hidden">
          <strong className="block text-[17px] font-[750] tracking-[1.1px] max-[900px]:text-sm">
            DELULU
          </strong>
          <small className="mt-px block text-[10px] tracking-[4px] text-[#59cfff] max-[900px]:text-[9px]">
            TALKS
          </small>
        </span>
      </button>
      <nav aria-label="Workspace">
        {groups.map((group) => (
          <section className="mb-6" key={group.label}>
            <p className="mb-2 px-3 text-[10px] font-semibold tracking-[1.3px] uppercase text-[#87abc6] max-[700px]:hidden">
              {group.label}
            </p>
            {group.items.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={`relative mt-[3px] flex w-full items-center gap-2.5 rounded-[5px] border border-transparent bg-transparent px-3 py-[11px] text-left text-[13px] text-[#bed2e4] max-[900px]:px-2.5 max-[900px]:py-2.5 max-[900px]:text-xs max-[700px]:justify-center max-[700px]:px-0 max-[700px]:py-3 ${
                  page === id || (page === "vocabulary" && id === "settings")
                    ? "active bg-[linear-gradient(90deg,rgba(19,87,131,0.9),rgba(16,53,79,0.85))] border-white/15 font-[650] text-[#b6efff] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] before:absolute before:-left-px before:top-[9px] before:bottom-[9px] before:w-[3px] before:rounded-[2px] before:bg-[#44ccff] before:content-['']"
                    : "rounded-[9px] hover:bg-white/10 hover:text-white"
                }`}
                aria-current={
                  page === id || (page === "vocabulary" && id === "settings")
                    ? "page"
                    : undefined
                }
                title={label}
                onClick={() => onNavigate(id)}
              >
                <Icon className="h-[17px] w-[17px]" />
                <span className="max-[700px]:hidden">{label}</span>
              </button>
            ))}
          </section>
        ))}
      </nav>
      <div className="mt-auto border-t border-[#22445e] pt-[18px] max-[700px]:hidden">
        <p className="mb-2 px-3 text-[10px] font-semibold tracking-[1.3px] uppercase text-[#87abc6] max-[700px]:hidden">
          Local engines
        </p>
        <button
          className="relative mt-[3px] flex w-full items-center gap-2.5 rounded-[5px] border border-transparent bg-transparent px-3 py-2 text-left text-[11px] text-[#bed2e4] rounded-[9px] hover:bg-white/10 hover:text-white"
          onClick={() => onNavigate("models")}
          title={status.message}
        >
          <span
            className={`engine-indicator block h-[6px] w-[6px] rounded-[2px] ${status.engine === "ready" ? "ready bg-[#35d5ba] shadow-[0_0_7px_#35d5ba33]" : "bg-[#6a859b]"}`}
          />
          <span>
            Speech
            <small className="mt-px block text-[10px] text-[#87abc6]">
              {status.migrationRequired
                ? "Update needed"
                : label(status.engine)}
            </small>
          </span>
        </button>
        <button
          className="relative mt-[3px] flex w-full items-center gap-2.5 rounded-[5px] border border-transparent bg-transparent px-3 py-2 text-left text-[11px] text-[#bed2e4] rounded-[9px] hover:bg-white/10 hover:text-white"
          onClick={() => onNavigate("magic")}
          title={magicStatus.message}
        >
          <span
            className={`engine-indicator block h-[6px] w-[6px] rounded-[2px] ${magicStatus.engine === "ready" ? "ready bg-[#35d5ba] shadow-[0_0_7px_#35d5ba33]" : "bg-[#6a859b]"}`}
          />
          <span>
            Writing
            <small className="mt-px block text-[10px] text-[#87abc6]">
              {label(magicStatus.engine)}
            </small>
          </span>
        </button>
        <span className="block px-3 pt-3 text-[9px] text-[#7ea2be]">
          Processing on this device
        </span>
      </div>
    </aside>
  );
}
