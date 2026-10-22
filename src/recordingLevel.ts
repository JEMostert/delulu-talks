import { bridge } from "./bridge";

/** Live input level from the native recorder (`recorder:level`). */
export interface RecordingLevelSnapshot {
  /** 0–1 as sent by the desktop. */
  level: number;
  /** The same level in dBFS, −60 when idle or silent. */
  db: number;
}

const idle: RecordingLevelSnapshot = { level: 0, db: -60 };
// Levels arrive about 20 times a second; a quiet gap means capture stopped.
const STALE_MS = 400;
// The desktop sends min(1, rms × 4.2), the audible scale the overlay uses.
const LEVEL_SCALE = 4.2;

let snapshot = idle;
let stale: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

export function levelToDb(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return -60;
  const rms = Math.min(1, level) / LEVEL_SCALE;
  return Math.round(Math.max(-60, Math.min(0, 20 * Math.log10(rms))));
}

function publish(next: RecordingLevelSnapshot): void {
  if (next.level === snapshot.level && next.db === snapshot.db) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function receive(level: number): void {
  const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  publish({ level: value, db: levelToDb(value) });
  if (stale) clearTimeout(stale);
  stale = setTimeout(() => {
    stale = null;
    publish(idle);
  }, STALE_MS);
}

/** Subscribes to the desktop only while something displays the level. */
export const recordingLevelStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    unsubscribe ??= bridge.onRecordingLevel(receive);
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      unsubscribe?.();
      unsubscribe = null;
      if (stale) clearTimeout(stale);
      stale = null;
      snapshot = idle;
    };
  },
  getSnapshot: () => snapshot,
  getServerSnapshot: () => idle,
};
