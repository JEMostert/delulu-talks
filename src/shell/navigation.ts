import {
  AudioLines,
  BookA,
  Clock3,
  Cpu,
  Home,
  Settings2,
  Speech,
  type LucideIcon,
} from "lucide-react";
import type { Page } from "../types";

/** Dock order. Page ids are persisted and used over IPC; only titles are branded. */
export const DESTINATIONS: readonly {
  page: Page;
  title: string;
  Icon: LucideIcon;
}[] = [
  { page: "home", title: "Home", Icon: Home },
  { page: "history", title: "Logbook", Icon: Clock3 },
  { page: "lab", title: "Bottles", Icon: AudioLines },
  { page: "models", title: "Engines", Icon: Cpu },
  { page: "vocabulary", title: "Lingo", Icon: BookA },
  { page: "voice", title: "Siren", Icon: Speech },
  { page: "settings", title: "Settings", Icon: Settings2 },
];

export const pageTitle = (page: Page) =>
  DESTINATIONS.find((destination) => destination.page === page)!.title;
