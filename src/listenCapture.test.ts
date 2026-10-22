import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ListenCaptureEvent } from "./listening";
import type { VoicePlayer } from "./voicePlayer";

// Vite resolves the worklet URL; tests never open a real audio graph.
mock.module("./captureWorklet.js?url&no-inline", () => ({ default: "" }));
const { ListenCapture } = await import("./listenCapture");

function speech(name: string): Float32Array {
  const bytes = readFileSync(
    join(import.meta.dir, "../tests/fixtures/voice", `${name}.wav`),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output = new Float32Array((bytes.length - 44) / 2);
  for (let i = 0; i < output.length; i++)
    output[i] = view.getInt16(44 + i * 2, true) / 32768;
  return output;
}

test("talking over playback stops the player at once and reports the cut-off reply", () => {
  const events: ListenCaptureEvent[] = [];
  let playing = true;
  const interrupted: string[][] = [];
  const player = {
    isPlaying: () => playing,
    outputLevelDb: () => -60,
    interrupt: () => {
      playing = false;
      interrupted.push(["reply-1"]);
      return ["reply-1"];
    },
  } as unknown as VoicePlayer;
  const capture = new ListenCapture(
    "session-1",
    {
      deviceId: "default",
      sensitivity: 0.5,
      silenceMs: 900,
      minSpeechMs: 200,
      preRollMs: 500,
      bargeIn: true,
      bargeInMs: 300,
      maxUtteranceMs: 60_000,
    },
    (event) => events.push(event),
    () => player,
  );
  const audio = new Float32Array(
    16_000 + speech("user-question").length + 32_000,
  );
  audio.set(speech("user-question"), 16_000);
  for (let offset = 0; offset < audio.length; offset += 320)
    capture.ingest(audio.subarray(offset, offset + 320));
  expect(interrupted).toHaveLength(1);
  const types = events.map((event) => event.type);
  // Playback stops (barge-in) before the transcript-bearing utterance exists.
  expect(types.indexOf("bargeIn")).toBeLessThan(types.indexOf("utterance"));
  expect(events.find((event) => event.type === "bargeIn")).toMatchObject({
    utteranceIds: ["reply-1"],
  });
  const utterance = events.find((event) => event.type === "utterance");
  expect(utterance).toMatchObject({
    sessionId: "session-1",
    overlappedPlayback: true,
  });
  const wav = (utterance as Extract<ListenCaptureEvent, { type: "utterance" }>)
    .wav;
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
});
