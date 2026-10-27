import type { Phase } from "../ipc";

/** What the pearl is showing: an app phase, or the first-run microphone check. */
export type PearlMode = Phase | "micTest";
/** A short-lived result colour laid over the mode, like the pill's one word. */
export type Flash = "success" | "warning" | null;
export type Rgb = readonly [number, number, number];

export const palette = {
  coral: [255, 111, 134],
  foam: [117, 228, 255],
  seaglass: [95, 220, 191],
  amber: [246, 201, 121],
  lavender: [194, 173, 219],
  ink: [234, 246, 255],
} as const satisfies Record<string, Rgb>;

export type PearlParams = {
  /** Halo colour around the pearl. */
  halo: Rgb;
  /** Halo strength without voice, 0..1. */
  glow: number;
  /** How much the mic level adds to the halo and size. */
  voice: number;
  /** Breathing amplitude as a fraction of the radius. */
  breathe: number;
  /** Surface wobble at full voice, as a fraction of the radius. */
  wobble: number;
  /** Speed of the iridescent sheen, radians per second. */
  sheen: number;
  /** How far the pearl is dimmed, 0..1. */
  dim: number;
  /** Opacity of the orbiting "working" arc, 0..1. */
  orbit: number;
  /** Opacity of the voice ripples, 0..1. */
  rings: number;
};

const calm: PearlParams = {
  halo: palette.lavender,
  glow: 0.4,
  voice: 0,
  breathe: 0.006,
  wobble: 0,
  sheen: 0.12,
  dim: 0,
  orbit: 0,
  rings: 0,
};

export function pearlTarget(mode: PearlMode, flash: Flash): PearlParams {
  if (flash === "success")
    return { ...calm, halo: palette.seaglass, glow: 0.75, sheen: 0.3 };
  if (flash === "warning")
    return { ...calm, halo: palette.amber, glow: 0.7, sheen: 0.2 };
  switch (mode) {
    case "recording":
      return {
        ...calm,
        halo: palette.coral,
        glow: 0.62,
        voice: 1,
        wobble: 0.04,
        sheen: 0.5,
        rings: 1,
      };
    case "micTest":
      return {
        ...calm,
        halo: palette.foam,
        glow: 0.3,
        voice: 0.9,
        wobble: 0.04,
      };
    case "transcribing":
      return {
        ...calm,
        halo: palette.foam,
        glow: 0.6,
        breathe: 0.035,
        sheen: 0.9,
      };
    case "loadingModel":
      return { ...calm, halo: palette.foam, glow: 0.22, dim: 0.45, orbit: 1 };
    case "error":
      return {
        ...calm,
        halo: palette.amber,
        glow: 0.6,
        sheen: 0.05,
        dim: 0.15,
      };
    case "needsSetup":
      return { ...calm, glow: 0.18, dim: 0.35 };
    case "idle":
      return calm;
  }
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** Moves every parameter a step of `k` (0..1) towards the target. */
export function approach(
  current: PearlParams,
  target: PearlParams,
  k: number,
): PearlParams {
  return {
    halo: [
      mix(current.halo[0], target.halo[0], k),
      mix(current.halo[1], target.halo[1], k),
      mix(current.halo[2], target.halo[2], k),
    ],
    glow: mix(current.glow, target.glow, k),
    voice: mix(current.voice, target.voice, k),
    breathe: mix(current.breathe, target.breathe, k),
    wobble: mix(current.wobble, target.wobble, k),
    sheen: mix(current.sheen, target.sheen, k),
    dim: mix(current.dim, target.dim, k),
    orbit: mix(current.orbit, target.orbit, k),
    rings: mix(current.rings, target.rings, k),
  };
}

/** Exponential smoothing step for a frame of `dt` seconds. */
export const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);

/** Mic level smoothing: quick to rise with the voice, slower to settle. */
export function smoothLevel(current: number, target: number, dt: number) {
  const clamped = Math.min(1, Math.max(0, target));
  return mix(current, clamped, ease(dt, clamped > current ? 22 : 5));
}

/** Radius multiplier of the pearl's edge at angle `theta` and time `t`. */
export function edge(theta: number, t: number, wobble: number): number {
  return (
    1 +
    wobble *
      (0.5 * Math.sin(3 * theta + 2.1 * t) +
        0.3 * Math.sin(5 * theta - 1.7 * t) +
        0.2 * Math.sin(2 * theta + 1.3 * t))
  );
}

export const rgba = (color: Rgb, alpha: number) =>
  `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${Math.max(0, Math.min(1, alpha))})`;
