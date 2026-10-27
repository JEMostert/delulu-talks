import { expect, test } from "bun:test";
import { approach, edge, palette, pearlTarget, smoothLevel } from "./model";

test("each state has its own colour, matching the recording pill", () => {
  expect(pearlTarget("recording", null).halo).toEqual(palette.coral);
  expect(pearlTarget("transcribing", null).halo).toEqual(palette.foam);
  expect(pearlTarget("error", null).halo).toEqual(palette.amber);
  expect(pearlTarget("idle", "success").halo).toEqual(palette.seaglass);
  expect(pearlTarget("loadingModel", null).orbit).toBe(1);
  expect(pearlTarget("idle", null).voice).toBe(0);
});
test("approach moves towards the target without overshooting", () => {
  const from = pearlTarget("idle", null);
  const to = pearlTarget("recording", null);
  const half = approach(from, to, 0.5);
  expect(half.glow).toBeCloseTo((from.glow + to.glow) / 2);
  expect(approach(from, to, 1)).toEqual({ ...to, halo: [...to.halo] });
});
test("level rises fast, falls slowly and stays in range", () => {
  const up = smoothLevel(0, 1, 0.05);
  const down = 1 - smoothLevel(1, 0, 0.05);
  expect(up).toBeGreaterThan(down);
  expect(smoothLevel(0, 5, 10)).toBeLessThanOrEqual(1);
  expect(edge(1, 2, 0)).toBe(1);
});
