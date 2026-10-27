import { useEffect, useRef } from "react";
import { drawPearl } from "./draw";
import {
  approach,
  ease,
  pearlTarget,
  smoothLevel,
  type Flash,
  type PearlMode,
} from "./model";

type Props = {
  mode: PearlMode;
  level?: number;
  flash?: Flash;
  label: string;
  className?: string;
};

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The living pearl. It owns one small canvas and one animation loop; React
 * only hands it the latest mode and level through a ref, so mic updates never
 * restart the loop.
 */
export function Pearl({
  mode,
  level = 0,
  flash = null,
  label,
  className,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const input = useRef({ mode, level, flash });
  input.current = { mode, level, flash };
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let width = 0;
    let height = 0;
    let params = pearlTarget(input.current.mode, input.current.flash);
    let smoothed = 0;
    let started = performance.now();
    let last = started;
    let lastPaint = 0;
    let frameId = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const paint = (now: number, still: boolean) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { mode, level, flash } = input.current;
      const target = pearlTarget(mode, flash);
      params = still ? target : approach(params, target, ease(dt, 4));
      smoothed = still ? level : smoothLevel(smoothed, level, dt);
      const t = still ? 0.8 : (now - started) / 1000;
      const frameParams = still
        ? {
            ...params,
            breathe: 0,
            rings: 0,
            wobble: 0,
            orbit: params.orbit * 0.8,
          }
        : params;
      drawPearl(ctx, width, height, {
        t,
        level: smoothed,
        params: frameParams,
      });
    };
    const loop = (now: number) => {
      frameId = requestAnimationFrame(loop);
      if (document.hidden) return;
      // Calm states only need a gentle shimmer; spare the GPU there.
      const { mode, flash } = input.current;
      const calm = (mode === "idle" || mode === "needsSetup") && !flash;
      if (calm && now - lastPaint < 40) return;
      lastPaint = now;
      paint(now, false);
    };

    const still = reducedMotion();
    resize();
    redraw.current = () => paint(performance.now(), true);
    const observer = new ResizeObserver(() => {
      resize();
      if (still) redraw.current();
    });
    observer.observe(canvas);
    if (still) redraw.current();
    else {
      started = performance.now();
      frameId = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      redraw.current = () => {};
    };
  }, []);

  // With reduced motion there is no loop: repaint once per change instead.
  useEffect(() => {
    if (reducedMotion()) redraw.current();
  }, [mode, level, flash]);

  return (
    <canvas
      ref={canvasRef}
      className={`pearl ${className ?? ""}`}
      role="img"
      aria-label={label}
    />
  );
}
