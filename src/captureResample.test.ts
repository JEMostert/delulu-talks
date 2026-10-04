import { describe, expect, test } from "bun:test";
import { resample } from "./captureResample";

function tone(frequency: number, rate: number, seconds: number) {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / rate);
  return samples;
}

/** RMS level in dB of the middle half, away from zero-padded edges. */
function level(samples: Float32Array): number {
  const from = Math.floor(samples.length / 4);
  const to = Math.floor((samples.length * 3) / 4);
  let sum = 0;
  for (let index = from; index < to; index += 1)
    sum += samples[index] * samples[index];
  return 10 * Math.log10(sum / (to - from));
}

describe("resample", () => {
  const reference = level(tone(1000, 16_000, 0.5));
  test("keeps speech-band tones", () => {
    for (const rate of [44_100, 48_000]) {
      const output = resample(tone(1000, rate, 0.5), rate);
      expect(output.length).toBe(8000);
      expect(Math.abs(level(output) - reference)).toBeLessThan(1);
    }
  });
  test("removes tones that would alias into speech", () => {
    for (const frequency of [9_000, 12_000, 20_000])
      expect(
        level(resample(tone(frequency, 48_000, 0.5), 48_000)) - reference,
      ).toBeLessThan(-40);
  });
  test("returns the input when no conversion is needed", () => {
    const input = tone(440, 16_000, 0.1);
    expect(resample(input, 16_000)).toBe(input);
    expect(resample(new Float32Array(), 48_000).length).toBe(0);
  });
  test("handles ten minutes of 48 kHz audio quickly", () => {
    const started = performance.now();
    resample(new Float32Array(48_000 * 600), 48_000);
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});
