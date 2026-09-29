// These bounds apply to live microphone capture, independently of import size.
export const MAX_CAPTURE_DURATION_MS = 10 * 60 * 1000;
export const MAX_CAPTURE_PCM_BYTES = 128 * 1024 * 1024;
export const MAX_CAPTURE_SAMPLES =
  MAX_CAPTURE_PCM_BYTES / Float32Array.BYTES_PER_ELEMENT;
