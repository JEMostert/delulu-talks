import { encodeRecording } from "./captureEncoding";

/** Keep sinc resampling and WAV encoding off the interface thread. */
export function encodeCapture(
  chunks: Float32Array[],
  sampleRate: number,
  cancellation: Promise<void>,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (wav: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(wav);
    };
    const fallback = () => {
      if (settled) return;
      worker?.terminate();
      try {
        finish(encodeRecording(chunks, sampleRate));
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    };
    void cancellation.then(() => finish(null));
    try {
      worker = new Worker(
        new URL("./captureEncoder.worker.ts", import.meta.url),
        {
          type: "module",
          name: "dictation-encoder",
        },
      );
      worker.onmessage = (event: MessageEvent<Uint8Array>) => {
        if (event.data instanceof Uint8Array && event.data.byteLength >= 44)
          finish(event.data);
        else fallback();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fallback();
      };
      worker.onmessageerror = fallback;
      timer = setTimeout(fallback, 30_000);
      // Keep the original chunks until success so a worker/CSP/startup failure
      // can use the existing encoder without losing the user's recording.
      worker.postMessage({ chunks, sampleRate });
    } catch {
      fallback();
    }
  });
}
