import { encodeRecording } from "./captureEncoding";

// PCM remains private to the renderer and this short-lived local worker.
self.onmessage = (
  event: MessageEvent<{ chunks: Float32Array[]; sampleRate: number }>,
) => {
  const wav = encodeRecording(event.data.chunks, event.data.sampleRate);
  self.postMessage(wav, { transfer: [wav.buffer] });
};
