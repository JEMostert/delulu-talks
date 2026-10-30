import type { Phase } from "../ipc";
import type { Page } from "../state";
import { Icon, type IconName } from "./Icon";

const allPages: { page: Page; icon: IconName }[] = [
  { page: "Home", icon: "home" },
  { page: "History", icon: "history" },
  { page: "Cleanup", icon: "cleanup" },
  { page: "LLM FM", icon: "radio" },
  { page: "Settings", icon: "settings" },
];

export const phaseWord: Record<Phase, string> = {
  needsSetup: "Setup needed",
  loadingModel: "Loading model",
  idle: "Ready",
  recording: "Listening",
  transcribing: "Writing it down",
  error: "Needs attention",
};

export function Wordmark() {
  return (
    <div className="wordmark">
      <span className="pearl-dot" aria-hidden="true" />
      <span>Delulu Talks</span>
    </div>
  );
}

export function Header({
  page,
  phase,
  radio,
  onNavigate,
}: {
  page: Page;
  phase: Phase;
  /** Show the optional LLM FM tab. */
  radio: boolean;
  onNavigate: (page: Page) => void;
}) {
  const pages = allPages.filter((p) => radio || p.page !== "LLM FM");
  const index = pages.findIndex((p) => p.page === page);
  return (
    <header className="topbar">
      <Wordmark />
      <nav className="tabs" aria-label="Main" data-count={pages.length}>
        {pages.map(({ page: item, icon }) => (
          <button
            key={item}
            type="button"
            className="tab"
            aria-current={page === item ? "page" : undefined}
            onClick={() => onNavigate(item)}
          >
            <Icon name={icon} size={17} />
            {item}
          </button>
        ))}
        <span
          className="tab-pearl"
          aria-hidden="true"
          style={{ transform: `translateX(${index * 100}%)` }}
        />
      </nav>
      <div
        className={`status-chip phase-${phase} ${page === "Home" ? "quiet" : ""}`}
        role="status"
      >
        <span className="status-dot" aria-hidden="true" />
        {phaseWord[phase]}
      </div>
    </header>
  );
}
