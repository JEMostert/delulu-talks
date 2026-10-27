import type { HistoryEntry, InsertResult, Language, Settings } from "./ipc";
export const formatMs = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
export const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
export const languageName = (code: string, languages: Language[]) => {
  const name =
    languages.find((language) => language.code === code)?.name ?? code;
  return name.charAt(0).toUpperCase() + name.slice(1);
};
export const settingsPatch = <K extends keyof Settings>(
  settings: Settings,
  key: K,
  value: Settings[K],
): Settings => ({ ...settings, [key]: value });
export function insertMessage(result: InsertResult): string {
  switch (result.kind) {
    case "pasted":
      return "Inserted";
    case "copied":
      return "Copied — press Ctrl+V";
    case "failed":
      return `Could not insert or copy: ${result.reason}`;
    case "skipped":
      return "Nothing to insert";
  }
}
/** The single word the pearl shows after a dictation, like the pill does. */
export function resultWord(result: InsertResult): string {
  switch (result.kind) {
    case "pasted":
      return "Inserted";
    case "copied":
      return "Copied";
    case "failed":
      return "Not inserted";
    case "skipped":
      return "Nothing heard";
  }
}
const keyNames: Record<string, string> = {
  super: "Super",
  logo: "Super",
  meta: "Super",
  ctrl: "Ctrl",
  control: "Ctrl",
  primary: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  space: "Space",
};
const prettyKey = (key: string) =>
  keyNames[key.toLowerCase()] ??
  (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
/** Splits a portal trigger ("Super+Z", "<Super>z", "Press Ctrl+Alt+D") into keycaps. */
export function hotkeyKeys(trigger: string | null | undefined): string[] {
  if (!trigger) return [];
  const keys: string[] = [];
  const rest = trigger
    .trim()
    .replace(/^press\s+/i, "")
    .replace(/<([^>]+)>/g, (_, modifier: string) => {
      keys.push(modifier);
      return "";
    });
  keys.push(...rest.split("+").map((key) => key.trim()));
  return keys.filter(Boolean).map(prettyKey);
}
const dayStart = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
export function dayLabel(timestamp: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(timestamp)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year:
      date.getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  });
}
/** Short "when" for the recent list: just now, minutes ago, or a time. */
export function whenLabel(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const day = dayLabel(timestamp, now);
  return day === "Today"
    ? formatTime(timestamp)
    : `${day}, ${formatTime(timestamp)}`;
}
export type DayGroup = { label: string; entries: HistoryEntry[] };
/** Groups newest-first entries by calendar day, keeping their order. */
export function groupByDay(
  entries: HistoryEntry[],
  now = Date.now(),
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const label = dayLabel(entry.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}
export type Segment = { text: string; match: boolean };
/** Splits text around case-insensitive matches of the query. */
export function highlight(text: string, query: string): Segment[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const segments: Segment[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, from)
  ) {
    if (at > from) segments.push({ text: text.slice(from, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length)
    segments.push({ text: text.slice(from), match: false });
  return segments;
}
export const noticeTone = (notice: string): "error" | "info" =>
  /^(could not|failed)/i.test(notice) || /error/i.test(notice)
    ? "error"
    : "info";
/** Confirmations that can fade on their own; anything else waits for a dismiss. */
export const isTransientNotice = (notice: string) =>
  ["Copied to clipboard", "Inserted", "Nothing to insert"].includes(notice);
