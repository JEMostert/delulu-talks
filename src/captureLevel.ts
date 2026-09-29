export type CaptureLevelState =
  | "idle"
  | "waiting"
  | "quiet"
  | "signal"
  | "muted"
  | "ended"
  | "suspended"
  | "stalled";

export interface CaptureLevelSnapshot {
  state: CaptureLevelState;
  db: number;
}

const idle: CaptureLevelSnapshot = { state: "idle", db: -60 };
let snapshot = idle;
let owner: symbol | null = null;
const listeners = new Set<() => void>();

function publish(next: CaptureLevelSnapshot): void {
  if (next.state === snapshot.state && next.db === snapshot.db) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export const captureLevelStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot: () => snapshot,
  getServerSnapshot: () => idle,
};

// Ephemeral meter only: no sample buffers, persistence or microphone acquisition.
export function beginCaptureLevel(
  track: MediaStreamTrack,
  context: AudioContext,
) {
  const token = Symbol("capture-level");
  owner = token;
  let ended = false;
  let lastSampleAt = performance.now();
  let hasSamples = false;
  let quietSince: number | null = null;
  let db = -60;
  let signalState: CaptureLevelState = "waiting";
  let lastPublishedAt = 0;
  const refresh = (force = false) => {
    if (ended || owner !== token) return;
    const now = performance.now();
    const state: CaptureLevelState = track.readyState === "ended"
      ? "ended"
      : track.muted || !track.enabled
        ? "muted"
        : context.state !== "running"
          ? "suspended"
          : now - lastSampleAt > 1200
            ? "stalled"
            : hasSamples ? signalState : "waiting";
    // State transitions publish immediately; only meter amplitude is throttled.
    if (!force && state === snapshot.state && now - lastPublishedAt < 150) return;
    lastPublishedAt = now;
    publish({ state, db: state === "signal" || state === "quiet" ? db : -60 });
  };
  const onState = () => refresh(true);
  track.addEventListener("mute", onState);
  track.addEventListener("unmute", onState);
  track.addEventListener("ended", onState);
  context.addEventListener("statechange", onState);
  const watchdog = setInterval(onState, 300);
  publish({ state: "waiting", db: -60 });
  refresh(true);
  return {
    sample(rms: number) {
      if (ended || owner !== token || !Number.isFinite(rms) || rms < 0) return;
      const now = performance.now();
      lastSampleAt = now;
      hasSamples = true;
      db = Math.round(Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 1e-6)))));
      if (db <= -55) {
        quietSince ??= now;
        signalState = now - quietSince >= 600 ? "quiet" : "waiting";
      } else {
        quietSince = null;
        signalState = "signal";
      }
      refresh();
    },
    stop() {
      ended = true;
      clearInterval(watchdog);
      track.removeEventListener("mute", onState);
      track.removeEventListener("unmute", onState);
      track.removeEventListener("ended", onState);
      context.removeEventListener("statechange", onState);
      if (owner === token) {
        owner = null;
        publish(idle);
      }
    },
  };
}
