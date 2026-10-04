// These bounds apply to live microphone capture, independently of import size.
export const MAX_CAPTURE_DURATION_MS = 10 * 60 * 1000;
export const MAX_CAPTURE_PCM_BYTES = 128 * 1024 * 1024;
export const MAX_CAPTURE_SAMPLES =
  MAX_CAPTURE_PCM_BYTES / Float32Array.BYTES_PER_ELEMENT;

/** Prefix for a capture that ended before any audio: a tap, not a failure. */
export const TOO_SHORT = "Recording too short";
