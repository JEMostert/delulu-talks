import type { ShownPage } from "../types";
import { DOCK } from "./navigation";

/**
 * One side of the dock around the pearl. Choosing the open page again goes
 * back home, like closing the sheet.
 */
export function DockItems({
  side,
  page,
  onNavigate,
  onHome,
}: {
  side: 0 | 1;
  page: ShownPage;
  onNavigate: (page: ShownPage) => void;
  onHome: () => void;
}) {
  return DOCK[side].map(({ page: destination, title, Icon }) => (
    <button
      key={destination}
      className="dock-item"
      aria-current={page === destination ? "page" : undefined}
      onClick={() =>
        page === destination ? onHome() : onNavigate(destination)
      }
    >
      <Icon aria-hidden="true" />
      <span className="dock-label">{title}</span>
    </button>
  ));
}
