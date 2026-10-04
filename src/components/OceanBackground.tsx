import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { captureLevelStore } from "../captureLevel";

/**
 * The sea behind the app, built from layered gradients: no images, canvas or
 * GPU. Light rays sway from the surface, two ring fields drift against each
 * other into moving caustics, currents and motes add depth, and the water
 * glows with your voice while recording. Only transform and opacity animate.
 */

type Palette = {
  base: string;
  ray: string;
  caustic: string;
  current: string;
  glow: string;
  mote: string;
  voice: string;
  ripple: string;
};

const PALETTES: Record<"light" | "dark", Palette> = {
  dark: {
    base: "radial-gradient(ellipse 120% 90% at 30% -10%, #0a7d96 0%, #07405c 32%, #04233f 62%, #020c1d 100%)",
    ray: "143 232 245",
    caustic: "120 225 240",
    current: "20 120 150",
    glow: "110 220 235",
    mote: "170 235 245",
    voice: "90 210 230",
    ripple: "150 235 248",
  },
  light: {
    base: "radial-gradient(ellipse 120% 90% at 30% -10%, #ffffff 0%, #d6f3fa 28%, #9fd9ec 60%, #5fb3d6 100%)",
    ray: "255 255 255",
    caustic: "255 255 255",
    current: "255 255 255",
    glow: "255 253 240",
    mote: "255 255 255",
    voice: "255 255 255",
    ripple: "255 255 255",
  },
};

const rgba = (rgb: string, alpha: number) => `rgb(${rgb} / ${alpha})`;

/** Fades a layer out with depth: light lives near the surface. */
const surfaceMask = (reach: number): CSSProperties => {
  const mask = `linear-gradient(to bottom, #000 0%, rgb(0 0 0 / 0.55) ${reach * 0.45}%, transparent ${reach}%)`;
  return { maskImage: mask, WebkitMaskImage: mask };
};

/** Light shafts fanning down from a bright patch of surface. */
const rays = (rgb: string, period: number, strength: number): CSSProperties => {
  const ray = `repeating-conic-gradient(from 150deg at 30% -18%, transparent 0deg ${period * 0.55}deg, ${rgba(rgb, strength)} ${period * 0.7}deg, transparent ${period * 0.85}deg ${period}deg)`;
  const fan =
    "radial-gradient(ellipse 70% 95% at 30% -18%, #000 20%, transparent 78%)";
  return { backgroundImage: ray, maskImage: fan, WebkitMaskImage: fan };
};

/**
 * Dappled light: a tile of soft, uneven light patches. Two tiles of unrelated
 * sizes slide past each other, so where patches overlap the water shimmers.
 */
const dapples = (
  rgb: string,
  alpha: number,
  tile: number,
  patches: readonly (readonly [number, number, number, number])[],
): CSSProperties => ({
  backgroundImage: patches
    .map(
      ([x, y, rx, ry]) =>
        `radial-gradient(${rx}px ${ry}px at ${x}px ${y}px, ${rgba(rgb, alpha)}, ${rgba(rgb, alpha * 0.35)} 45%, transparent)`,
    )
    .join(", "),
  backgroundSize: `${tile}px ${tile}px`,
});

const DAPPLE_A = [
  [52, 46, 34, 18],
  [138, 98, 26, 14],
  [64, 140, 20, 12],
  [150, 24, 16, 10],
  [24, 96, 14, 9],
] as const;
const DAPPLE_B = [
  [70, 70, 40, 20],
  [182, 150, 30, 16],
  [176, 46, 22, 12],
  [52, 190, 24, 13],
  [116, 214, 14, 8],
] as const;

/** Fixed, hand-spread motes so the water never looks randomly reshuffled. */
const MOTES = [
  [8, 92, 26, 0, 1.5, 10],
  [17, 78, 34, -9, 2, -14],
  [26, 96, 29, -17, 1.5, 8],
  [38, 86, 38, -4, 2.5, 16],
  [47, 99, 31, -22, 1.5, -10],
  [58, 82, 36, -13, 2, 12],
  [66, 94, 27, -2, 1.5, -6],
  [74, 88, 33, -26, 2.5, 14],
  [83, 97, 30, -7, 2, -12],
  [91, 84, 37, -19, 1.5, 9],
  [33, 70, 42, -30, 1.5, -8],
  [70, 72, 40, -35, 2, 10],
] as const;

type Ripple = { id: number; x: number; y: number };

/**
 * Without a GPU (Wayland disables it), Chromium redraws the whole window in
 * software on every frame while any CSS animation runs. True when WebGL is
 * missing or reports a software rasterizer.
 */
function softwareCompositing(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return true;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|software/i.test(renderer);
  } catch {
    return true;
  }
}

export const OceanBackground = memo(function OceanBackground({
  recording,
  theme,
  covered,
}: {
  recording: boolean;
  theme: "light" | "dark";
  /** A workspace sheet hides most of the water; hold the small details still. */
  covered: boolean;
}) {
  const palette = PALETTES[theme];
  const oceanRef = useRef<HTMLDivElement>(null);
  const voiceRef = useRef<HTMLDivElement>(null);
  const coveredRef = useRef(covered);
  coveredRef.current = covered;

  // In software compositing, step the same Tailwind animations ourselves at a
  // low frame rate: the water moves too slowly for anyone to see the
  // difference, and the window is redrawn a fraction as often.
  useEffect(() => {
    const ocean = oceanRef.current;
    if (!ocean || !softwareCompositing()) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const times = new WeakMap<Animation, { time: number; held: boolean }>();
    let last = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      clearTimeout(timer);
      const now = performance.now();
      for (const animation of ocean.getAnimations({ subtree: true })) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const held =
          document.hidden ||
          motion.matches ||
          (coveredRef.current &&
            target instanceof Element &&
            target.hasAttribute("data-ocean-mote"));
        const previous = times.get(animation);
        const time =
          (previous?.time ?? Number(animation.currentTime ?? 0)) +
          (previous && !previous.held && !held ? now - last : 0);
        times.set(animation, { time, held });
        animation.pause();
        animation.currentTime = time;
      }
      last = now;
      // Sleep completely while hidden or motion is disabled; visibility and
      // preference events restart stepping. No 45 ms polling wakeups remain.
      if (!document.hidden && !motion.matches)
        timer = setTimeout(step, coveredRef.current ? 330 : 120);
    };
    step();
    document.addEventListener("visibilitychange", step);
    motion.addEventListener("change", step);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", step);
      motion.removeEventListener("change", step);
      for (const animation of ocean.getAnimations({ subtree: true }))
        animation.play();
    };
  }, []);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  // Voice energy brightens the water, ten updates a second and eased in CSS.
  useEffect(() => {
    const glow = voiceRef.current;
    if (!glow) return;
    if (!recording) {
      glow.style.opacity = "0";
      return;
    }
    let level = 0;
    const unsubscribe = captureLevelStore.subscribe(() => {
      level = Math.min(
        1,
        Math.max(0, (captureLevelStore.getSnapshot().db + 55) / 45),
      );
    });
    const timer = setInterval(() => {
      if (!document.hidden)
        glow.style.opacity = (0.15 + level * 0.85).toFixed(2);
    }, 100);
    return () => {
      unsubscribe();
      clearInterval(timer);
      glow.style.opacity = "0";
    };
  }, [recording]);

  // Touching open water leaves a ring of light.
  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let next = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const touch = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        motion.matches ||
        target?.closest(
          ".workspace-sheet, dialog, button, a, input, select, textarea, [role='menu']",
        )
      )
        return;
      const ripple = { id: next++, x: event.clientX, y: event.clientY };
      setRipples((current) => [...current.slice(-2), ripple]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setRipples((current) =>
          current.filter((item) => item.id !== ripple.id),
        );
      }, 1700);
      timers.add(timer);
    };
    window.addEventListener("pointerdown", touch, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", touch);
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute inset-0 -z-20 overflow-hidden transition-[background] duration-700"
      style={{ backgroundImage: palette.base }}
      ref={oceanRef}
      aria-hidden="true"
      data-ocean
    >
      {/* Sunlit patch of surface the rays fan out from. */}
      <div
        className="absolute -top-[30%] left-[30%] size-[70vmax] -translate-x-1/2 animate-ocean-breathe will-change-transform rounded-full"
        style={{
          backgroundImage: `radial-gradient(circle, ${rgba(palette.glow, theme === "light" ? 0.7 : 0.32)} 0%, ${rgba(palette.glow, 0.08)} 40%, transparent 68%)`,
        }}
      />

      {/* Two fans of light shafts swaying at different speeds. */}
      <div
        className="absolute -inset-[10%] origin-[30%_-18%] animate-ocean-sway will-change-transform mix-blend-screen"
        style={rays(palette.ray, 7, theme === "light" ? 0.32 : 0.11)}
      />
      <div
        className="absolute -inset-[10%] origin-[30%_-18%] animate-ocean-sway-slow will-change-transform mix-blend-screen"
        style={rays(palette.ray, 11, theme === "light" ? 0.22 : 0.07)}
      />

      {/* Dappled light: two patch fields slide past each other near the surface. */}
      <div className="absolute inset-0" style={surfaceMask(72)}>
        <div
          className="absolute -inset-[25%] animate-ocean-caustic will-change-transform mix-blend-screen"
          style={dapples(
            palette.caustic,
            theme === "light" ? 0.55 : 0.16,
            186,
            DAPPLE_A,
          )}
        />
        <div
          className="absolute -inset-[25%] animate-ocean-caustic-reverse will-change-transform mix-blend-screen"
          style={dapples(
            palette.caustic,
            theme === "light" ? 0.5 : 0.14,
            238,
            DAPPLE_B,
          )}
        />
      </div>

      {/* Slow, broad currents of lighter water. */}
      <div
        className="absolute -inset-[20%] animate-ocean-current will-change-transform"
        style={{
          backgroundImage: `radial-gradient(ellipse 40% 26% at 72% 62%, ${rgba(palette.current, theme === "light" ? 0.28 : 0.16)}, transparent 70%), radial-gradient(ellipse 34% 22% at 22% 78%, ${rgba(palette.current, theme === "light" ? 0.22 : 0.12)}, transparent 70%)`,
        }}
      />

      {/* Drifting motes, held still while a sheet covers the water. */}
      {MOTES.map(([left, top, duration, delay, size, drift], index) => (
        <span
          key={index}
          data-ocean-mote
          className="absolute animate-ocean-rise will-change-transform rounded-full"
          style={
            {
              left: `${left}%`,
              top: `${top}%`,
              width: size * 2,
              height: size * 2,
              background: rgba(palette.mote, theme === "light" ? 0.9 : 0.6),
              boxShadow: `0 0 ${size * 4}px ${rgba(palette.mote, 0.5)}`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
              animationPlayState: covered ? "paused" : "running",
              "--drift": `${drift}px`,
            } as CSSProperties
          }
        />
      ))}

      {/* Voice glow around the pearl while recording. */}
      <div
        ref={voiceRef}
        className="absolute inset-0 opacity-0 transition-opacity duration-150 ease-out"
        style={{
          backgroundImage: `radial-gradient(ellipse 45% 38% at 50% 46%, ${rgba(palette.voice, theme === "light" ? 0.45 : 0.2)}, transparent 70%)`,
        }}
      />

      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          className="absolute size-72 animate-ocean-ripple will-change-transform rounded-full border"
          style={{
            left: ripple.x,
            top: ripple.y,
            borderColor: rgba(palette.ripple, theme === "light" ? 0.8 : 0.45),
            boxShadow: `0 0 24px ${rgba(palette.ripple, 0.25)}, inset 0 0 24px ${rgba(palette.ripple, 0.15)}`,
          }}
        />
      ))}

      {/* Depth: darker edges, and a dim veil while a sheet is open. */}
      <div
        className={`absolute inset-0 transition-colors duration-500 ${
          !covered
            ? ""
            : theme === "light"
              ? "bg-[rgb(20_90_130/0.12)]"
              : "bg-[rgb(1_11_24/0.28)]"
        }`}
        style={{
          backgroundImage:
            theme === "light"
              ? "radial-gradient(ellipse at 50% 55%, transparent 30%, rgb(16 96 140 / 0.12))"
              : "radial-gradient(ellipse at 50% 55%, transparent 18%, rgb(1 11 24 / 0.1) 65%, rgb(1 11 24 / 0.45)), linear-gradient(transparent 55%, rgb(0 10 24 / 0.35))",
        }}
      />
    </div>
  );
});
