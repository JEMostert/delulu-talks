import type * as ipc from "../ipc";
import type { Page } from "../state";
import type { RadioState } from "../useRadio";
import { Keys } from "./Controls";
import { Icon, type IconName } from "./Icon";
import { MiniPlayer } from "./MiniPlayer";

/** Features first, then the places you set them up. */
const groups: { page: Page; icon: IconName }[][] = [
  [
    { page: "Dictate", icon: "mic" },
    { page: "Vocabulary", icon: "book" },
    { page: "Delulu FM", icon: "radio" },
    { page: "Voice", icon: "voice" },
  ],
  [
    { page: "Models", icon: "box" },
    { page: "Settings", icon: "settings" },
  ],
];

export const phaseWord: Record<ipc.Phase, string> = {
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

/** The left rail: pages, the radio's mini player and dictation's state. */
export function Rail({
  page,
  status,
  radioShown,
  radio,
  onNavigate,
}: {
  page: Page;
  status: ipc.Status;
  /** Show the optional Delulu FM page and its mini player. */
  radioShown: boolean;
  radio: RadioState;
  onNavigate: (page: Page) => void;
}) {
  const bound = status.hotkey.bound && status.hotkey.trigger;
  return (
    <aside className="rail">
      <Wordmark />
      <nav className="rail-nav" aria-label="Main">
        {groups.map((items, i) => (
          <ul key={i}>
            {items
              .filter((item) => radioShown || item.page !== "Delulu FM")
              .map(({ page: item, icon }) => (
                <li key={item}>
                  <button
                    type="button"
                    aria-current={page === item ? "page" : undefined}
                    onClick={() => onNavigate(item)}
                  >
                    <Icon name={icon} size={17} />
                    {item}
                  </button>
                </li>
              ))}
          </ul>
        ))}
      </nav>
      <div className="rail-foot">
        {radioShown && (
          <MiniPlayer radio={radio} onOpen={() => onNavigate("Delulu FM")} />
        )}
        <div
          className={`rail-status phase-${status.phase}`}
          // Dictate's pearl already announces each change.
          role={page === "Dictate" ? undefined : "status"}
          data-tip={
            bound ? "Hold to talk, or tap to start and stop" : "No hotkey set"
          }
        >
          <span className="status-dot" aria-hidden="true" />
          <span className="rail-phase">{phaseWord[status.phase]}</span>
          {bound && status.phase === "idle" && (
            <Keys trigger={status.hotkey.trigger} small />
          )}
        </div>
      </div>
    </aside>
  );
}
