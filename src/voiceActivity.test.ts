import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FRAME_SAMPLES,
  SAMPLE_RATE,
  UtteranceSegmenter,
  type SegmenterConfig,
  type SegmenterEvent,
} from "./voiceActivity";

// Speech fixtures were synthesized with the local Kokoro voice model: the
// "user" is am_michael, Delulu is af_heart. Each starts at its first word.
const fixture = (name: string) => {
  const bytes = readFileSync(
    join(import.meta.dir, "../tests/fixtures/voice", `${name}.wav`),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset < bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const output = new Float32Array(size / 2);
      for (let i = 0; i < output.length; i++)
        output[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return output;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No audio in ${name}`);
};
const question = fixture("user-question");
const followup = fixture("user-followup");
const reply = fixture("delulu-reply");

const CONFIG: SegmenterConfig = {
  sensitivity: 0.5,
  silenceMs: 900,
  minSpeechMs: 200,
  preRollMs: 500,
  bargeInMs: 300,
  maxUtteranceMs: 60_000,
};
const ms = (value: number) => Math.round((value * SAMPLE_RATE) / 1000);

/** Seeded low-level room noise, about −60 dBFS. */
function noise(length: number, seed = 7): Float32Array {
  const output = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    output[i] = (state / 2_147_483_648 - 0.5) * 0.0035;
  }
  return output;
}

function add(target: Float32Array, source: Float32Array, at: number, gain = 1) {
  for (let i = 0; i < source.length && at + i < target.length; i++)
    target[at + i] += source[i] * gain;
}

/** What the microphone hears of the speakers: quieter, later, duller. */
function echoOf(playback: Float32Array): Float32Array {
  const delay = ms(40);
  const output = new Float32Array(playback.length + delay);
  let low = 0;
  for (let i = 0; i < playback.length; i++) {
    low += 0.35 * (playback[i] - low);
    output[i + delay] = low * 0.2;
  }
  return output;
}

type Run = { events: (SegmenterEvent & { atMs: number })[] };

/** Feed mic audio frame by frame; `playback` plays from `playAt` until `stopAt`. */
function run(
  mic: Float32Array,
  playback?: { audio: Float32Array; playAt: number },
  options: { stopOnBargeIn?: boolean } = {},
): Run {
  const segmenter = new UtteranceSegmenter(CONFIG);
  const events: Run["events"] = [];
  let stoppedAt = Infinity;
  for (
    let start = 0;
    start + FRAME_SAMPLES <= mic.length;
    start += FRAME_SAMPLES
  ) {
    let playing = false;
    let playbackDb = -120;
    if (playback && start >= playback.playAt && start < stoppedAt) {
      const offset = start - playback.playAt;
      if (offset < playback.audio.length) {
        playing = true;
        let energy = 0;
        for (let i = 0; i < FRAME_SAMPLES; i++)
          energy += (playback.audio[offset + i] ?? 0) ** 2;
        playbackDb = 10 * Math.log10(energy / FRAME_SAMPLES + 1e-12);
      }
    }
    for (const event of segmenter.push(
      mic.slice(start, start + FRAME_SAMPLES),
      {
        playing,
        playbackDb,
      },
    )) {
      events.push({
        ...event,
        atMs: ((start + FRAME_SAMPLES) * 1000) / SAMPLE_RATE,
      });
      if (event.type === "bargeIn" && options.stopOnBargeIn) stoppedAt = start;
    }
  }
  for (const event of segmenter.flush())
    events.push({ ...event, atMs: (mic.length * 1000) / SAMPLE_RATE });
  return { events };
}

const utterances = (result: Run) =>
  result.events.filter(
    (
      event,
    ): event is Extract<SegmenterEvent, { type: "utterance" }> & {
      atMs: number;
    } => event.type === "utterance",
  );

test("a quiet pause ends an utterance and keeps its first word", () => {
  const onset = ms(1500);
  const mic = noise(onset + question.length + ms(2000));
  add(mic, question, onset);
  const found = utterances(run(mic));
  expect(found).toHaveLength(1);
  const [utterance] = found;
  // Starts before the first word, by no more than the pre-roll.
  expect(utterance.startSample).toBeLessThanOrEqual(onset);
  expect(onset - utterance.startSample).toBeLessThanOrEqual(ms(500));
  // Ends within the silence window after the last word.
  const end = utterance.startSample + utterance.samples.length;
  expect(end).toBeGreaterThanOrEqual(onset + question.length - ms(100));
  // Finalized roughly one silence window after speech, not much later.
  expect(found[0].atMs).toBeLessThan(
    ((onset + question.length) * 1000) / SAMPLE_RATE + 1300,
  );
});

test("two sentences separated by a long pause become two utterances", () => {
  const mic = noise(
    ms(1000) + question.length + ms(2500) + followup.length + ms(2000),
  );
  add(mic, question, ms(1000));
  add(mic, followup, ms(1000) + question.length + ms(2500));
  expect(utterances(run(mic))).toHaveLength(2);
});

test("silence, room noise and brief knocks are not speech", () => {
  expect(run(noise(ms(6000))).events).toEqual([]);
  const mic = noise(ms(6000));
  for (const at of [800, 2200, 3900]) {
    // ~120 ms knock: a decaying low thud with a sharp attack.
    const knock = new Float32Array(ms(120));
    for (let i = 0; i < knock.length; i++)
      knock[i] =
        Math.exp(-i / ms(25)) *
        (0.5 * Math.sin((2 * Math.PI * 180 * i) / SAMPLE_RATE) +
          0.3 * Math.sin((2 * Math.PI * 900 * i) / SAMPLE_RATE));
    add(mic, knock, ms(at));
  }
  expect(run(mic).events.filter((event) => event.type !== "discarded")).toEqual(
    [],
  );
});

test("Delulu's own voice through the speakers never interrupts it", () => {
  const playAt = ms(500);
  const mic = noise(playAt + reply.length + ms(2000));
  add(mic, echoOf(reply), playAt);
  const events = run(mic, { audio: reply, playAt }).events;
  expect(events.filter((event) => event.type === "bargeIn")).toEqual([]);
  expect(utterances({ events })).toEqual([]);
});

test("talking over Delulu interrupts promptly and keeps the start of the sentence", () => {
  const playAt = ms(500);
  const userAt = playAt + ms(2000);
  const mic = noise(userAt + question.length + ms(2000));
  add(mic, echoOf(reply), playAt);
  add(mic, question, userAt);
  const result = run(mic, { audio: reply, playAt }, { stopOnBargeIn: true });
  const bargeIn = result.events.find((event) => event.type === "bargeIn");
  expect(bargeIn).toBeDefined();
  const userMs = (userAt * 1000) / SAMPLE_RATE;
  expect(bargeIn!.atMs - userMs).toBeLessThanOrEqual(CONFIG.bargeInMs + 150);
  const found = utterances(result);
  expect(found).toHaveLength(1);
  expect(found[0].overlappedPlayback).toBe(true);
  expect(found[0].startSample).toBeLessThanOrEqual(userAt);
  expect(userAt - found[0].startSample).toBeLessThanOrEqual(ms(500));
});

test("after an interruption the next reply plays and can be interrupted again", () => {
  const first = ms(500);
  const firstUser = first + ms(1500);
  const second = firstUser + question.length + ms(2500);
  const secondUser = second + ms(1500);
  const mic = noise(secondUser + followup.length + ms(2000));
  // First reply is cut off by the user; the second reply plays from its start.
  add(mic, echoOf(reply.subarray(0, ms(1800))), first);
  add(mic, question, firstUser);
  add(mic, echoOf(reply.subarray(0, ms(1800))), second);
  add(mic, followup, secondUser);
  const segmenter = new UtteranceSegmenter(CONFIG);
  const bargeIns: number[] = [];
  let playing: { at: number; stopped: number } | null = null;
  const plays = [first, second];
  let utteranceCount = 0;
  for (
    let start = 0;
    start + FRAME_SAMPLES <= mic.length;
    start += FRAME_SAMPLES
  ) {
    if (plays.length && start >= plays[0])
      playing = { at: plays.shift()!, stopped: Infinity };
    let active = false;
    let playbackDb = -120;
    if (playing && start < playing.stopped && start - playing.at < ms(1800)) {
      active = true;
      let energy = 0;
      for (let i = 0; i < FRAME_SAMPLES; i++)
        energy += reply[start - playing.at + i] ** 2;
      playbackDb = 10 * Math.log10(energy / FRAME_SAMPLES + 1e-12);
    }
    for (const event of segmenter.push(
      mic.slice(start, start + FRAME_SAMPLES),
      {
        playing: active,
        playbackDb,
      },
    )) {
      if (event.type === "bargeIn") {
        bargeIns.push(start);
        if (playing) playing.stopped = start;
      }
      if (event.type === "utterance") utteranceCount += 1;
    }
  }
  expect(bargeIns).toHaveLength(2);
  expect(bargeIns[0]).toBeGreaterThanOrEqual(firstUser);
  expect(bargeIns[1]).toBeGreaterThanOrEqual(secondUser);
  expect(utteranceCount + segmenter.flush().length).toBe(2);
});
