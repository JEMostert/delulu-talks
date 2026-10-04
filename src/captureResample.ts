// Windowed-sinc (Kaiser) resampling. The low-pass sits below the lower Nyquist
// rate, so speech harmonics above it are removed instead of aliasing into the
// band the speech model hears.
const STOPBAND_DB = 70;
const KAISER_BETA = 0.1102 * (STOPBAND_DB - 8.7);
const MAX_PHASES = 4096;

function besselI0(value: number): number {
  let sum = 1;
  let term = 1;
  const half = value / 2;
  for (let k = 1; k < 64; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right) [left, right] = [right, left % right];
  return left;
}

/**
 * Resample mono PCM. Output sample `i` is centred on input position
 * `i * sourceRate / targetRate`, matching the previous interpolator's alignment.
 */
export function resample(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16_000,
): Float32Array {
  if (!input.length || sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const nyquist = Math.min(sourceRate, targetRate) / 2;
  // Pass up to 0.75 x Nyquist (6 kHz for 16 kHz output); stop from 1.05 x, so
  // anything that folds back lands above the passband.
  const cutoff = (0.9 * nyquist) / sourceRate;
  const transition = (0.3 * nyquist) / sourceRate;
  const taps = Math.ceil(
    (STOPBAND_DB - 8) / (2.285 * 2 * Math.PI * transition),
  );
  const half = Math.max(2, Math.ceil(taps / 2));
  const width = half * 2;

  const exact =
    Number.isInteger(sourceRate) && Number.isInteger(targetRate)
      ? greatestCommonDivisor(sourceRate, targetRate)
      : 0;
  const exactPhases = exact ? targetRate / exact : Infinity;
  const phases = exactPhases <= MAX_PHASES ? exactPhases : MAX_PHASES;
  const step = exactPhases <= MAX_PHASES ? sourceRate / exact : 0;

  const kernel = new Float32Array(phases * width);
  const normalizer = besselI0(KAISER_BETA);
  for (let phase = 0; phase < phases; phase += 1) {
    const fraction = phase / phases;
    let sum = 0;
    for (let tap = 0; tap < width; tap += 1) {
      // Tap `tap` reads input[base - half + 1 + tap].
      const distance = fraction - (tap - half + 1);
      const x = 2 * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const position = distance / half;
      const window =
        Math.abs(position) >= 1
          ? 0
          : besselI0(KAISER_BETA * Math.sqrt(1 - position * position)) /
            normalizer;
      const value = sinc * window;
      kernel[phase * width + tap] = value;
      sum += value;
    }
    // Unity DC gain per phase keeps quantized phases from adding ripple.
    for (let tap = 0; tap < width; tap += 1) kernel[phase * width + tap] /= sum;
  }

  const output = new Float32Array(length);
  const last = input.length - 1;
  for (let index = 0; index < length; index += 1) {
    let base: number;
    let phase: number;
    if (step) {
      const numerator = index * step;
      base = Math.floor(numerator / phases);
      phase = numerator - base * phases;
    } else {
      const position = index * ratio;
      base = Math.floor(position);
      phase = Math.round((position - base) * phases);
      if (phase === phases) {
        base += 1;
        phase = 0;
      }
    }
    const offset = phase * width;
    const first = base - half + 1;
    let value = 0;
    if (first >= 0 && first + width - 1 <= last) {
      for (let tap = 0; tap < width; tap += 1)
        value += input[first + tap] * kernel[offset + tap];
    } else {
      // Zero padding at the recording edges.
      for (let tap = 0; tap < width; tap += 1) {
        const source = first + tap;
        if (source >= 0 && source <= last)
          value += input[source] * kernel[offset + tap];
      }
    }
    output[index] = value;
  }
  return output;
}
