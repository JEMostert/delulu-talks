import {
  BookA,
  Clock3,
  Settings2,
  Speech,
  type LucideIcon,
} from "lucide-react";
import type { Page, SettingsSection, ShownPage } from "../types";

type Destination = { page: ShownPage; title: string; Icon: LucideIcon };

/** The dock, left and right of the pearl. Home is the ocean with no sheet open. */
export const DOCK: readonly [Destination[], Destination[]] = [
  [
    { page: "history", title: "History", Icon: Clock3 },
    { page: "vocabulary", title: "Words", Icon: BookA },
  ],
  [
    { page: "voice", title: "Voice", Icon: Speech },
    { page: "settings", title: "Settings", Icon: Settings2 },
  ],
];

export const pageTitle = (page: ShownPage) =>
  DOCK.flat().find((destination) => destination.page === page)?.title ?? "Home";

/** Older page ids land where their content lives now. */
export function resolvePage(target: Page): [ShownPage, SettingsSection?] {
  switch (target) {
    case "models":
      return ["settings", "dictation"];
    case "rewrite":
      return ["settings", "rewrite"];
    case "lab":
      return ["history"];
    default:
      return [target];
  }
}
