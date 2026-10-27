import type { Page } from "../types";
import { DESTINATIONS } from "./navigation";

/** Destinations around the pearl while a sheet is open. */
export function Dock({
  page,
  quickSheet,
  onNavigate,
  onHome,
}: {
  page: Page;
  quickSheet: boolean;
  onNavigate: (page: Page) => void;
  onHome: () => void;
}) {
  return (
    <nav className="panel-navigation" aria-label="Workspace">
      {DESTINATIONS.map(({ page: destination, title, Icon }) => (
        <button
          key={destination}
          className="dock-item"
          aria-label={title}
          aria-current={
            page === destination && (destination !== "home" || quickSheet)
              ? "page"
              : undefined
          }
          onClick={() =>
            destination === "home" ? onHome() : onNavigate(destination)
          }
        >
          <Icon aria-hidden="true" />
          <span className="dock-tip" aria-hidden="true">
            {title}
          </span>
        </button>
      ))}
    </nav>
  );
}
