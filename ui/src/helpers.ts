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
/** Raw mic RMS (0–1) to a 0–1 meter value on a dB scale: −60 dBFS reads as
 * empty, −6 dBFS as full, so normal speech (−40 to −20 dBFS) fills the middle. */
export const meterLevel = (rms: number) =>
  rms > 0 && Number.isFinite(rms)
    ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 54))
    : 0;
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
/** Splits a comma- or newline-separated list into tidy terms, like the backend does. */
export const splitTerms = (text: string): string[] =>
  text
    .split(/[,\n\r]/)
    .map((term) =>
      term
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
/** Pasted text that holds a list rather than one term. */
export const isTermList = (text: string) => /[,\n\r]/.test(text.trim());
export const termCount = (count: number) =>
  `${count} ${count === 1 ? "term" : "terms"}`;
/**
 * Runs async tasks one at a time, in call order, so replies can never arrive out
 * of order. A failed task does not stop the ones queued after it.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}
/**
 * Puts a pasted list that failed to save back into the term field. `before` and the
 * selection are from the moment of the paste; if the field changed since, the list
 * goes at the end so nothing typed meanwhile is lost. Single-line, comma-separated.
 */
export function restorePaste(
  now: string,
  before: string,
  start: number,
  end: number,
  pasted: string,
): string {
  const list = splitTerms(pasted).join(", ");
  if (!list) return now;
  if (now === before) {
    const head = before.slice(0, start);
    const tail = before.slice(end);
    const lead = head && !/[,\s]$/.test(head) ? ", " : "";
    const trail = tail && !/^[,\s]/.test(tail) ? ", " : "";
    return `${head}${lead}${list}${trail}${tail}`;
  }
  if (!now.trim()) return list;
  return `${now.replace(/[,\s]*$/, "")}, ${list}`;
}
