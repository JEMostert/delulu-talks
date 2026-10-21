import { describe, expect, test } from "bun:test";
import type { VoicePlaybackChunk, VoicePlaybackEvent } from "./voice";
import { createVoicePlayer } from "./voicePlayer";

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connections = 0;
  connect(target: unknown) {
    this.connections += 1;
    return target;
  }
  disconnect() {
    this.connections = 0;
  }
  start(at: number) {
    this.startedAt = at;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  state: "running" | "suspended" | "closed" = "suspended";
  currentTime = 10;
  destination = {};
  sources: FakeSource[] = [];
  gains: { gain: { value: number } }[] = [];
  sinks: string[] = [];
  resumed = 0;
  closed = false;
  rejectSinks = new Set<string>();
  createBuffer(_channels: number, length: number, rate: number) {
    if (rate < 3000) throw new Error("Unsupported sample rate");
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data, data };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = {
      gain: { value: 1 },
      connect: () => undefined,
      disconnect() {},
    };
    this.gains.push(gain);
    return gain;
  }
  async resume() {
    this.resumed += 1;
    this.state = "running";
  }
  async close() {
    this.closed = true;
  }
  async setSinkId(id: string) {
    this.sinks.push(id);
    if (this.rejectSinks.has(id)) throw new Error("Device not found");
  }
}

function pcm(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

function chunk(patch: Partial<VoicePlaybackChunk> = {}): VoicePlaybackChunk {
  return {
    utteranceId: "u1",
    chunk: 0,
    last: false,
    sampleRate: 24_000,
    pcm: pcm(Array(24_000).fill(1000)),
    volume: 0.5,
    outputDeviceId: "default",
    ...patch,
  };
}

function setup() {
  const context = new FakeContext();
  const events: VoicePlaybackEvent[] = [];
  const player = createVoicePlayer(
    (event) => events.push(event),
    () => context as unknown as AudioContext,
  );
  const summary = () =>
    events.map((e) => `${e.utteranceId}:${e.chunk}:${e.event}`);
  return { context, events, player, summary };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createVoicePlayer", () => {
  test("decodes 16-bit PCM and applies volume", () => {
    const { context, player } = setup();
    player.play(chunk({ pcm: pcm([0, 16384, -32768, 32767]), volume: 0.3 }));
    const buffer = context.sources[0].buffer as unknown as {
      data: Float32Array;
    };
    expect([...buffer.data]).toEqual([0, 0.5, -1, 32767 / 32768]);
    expect(context.gains[0].gain.value).toBe(0.3);
    expect(context.resumed).toBe(1);
  });

  test("schedules chunks back to back and reports start and end", () => {
    const { context, player, summary } = setup();
    player.play(chunk({ chunk: 0 }));
    player.play(chunk({ chunk: 1, last: true }));
    const [first, second] = context.sources;
    expect(first.startedAt).toBeCloseTo(10.03, 5);
    expect(second.startedAt).toBeCloseTo(11.03, 5);
    expect(summary()).toEqual(["u1:0:started"]);
    first.onended?.();
    second.onended?.();
    expect(summary()).toEqual([
      "u1:0:started",
      "u1:0:ended",
      "u1:1:started",
      "u1:1:ended",
    ]);
  });

  test("stopping an utterance silences it and reports nothing more", () => {
    const { context, player, summary } = setup();
    player.play(chunk({ chunk: 0 }));
    player.play(chunk({ chunk: 1 }));
    player.play(chunk({ utteranceId: "u2", chunk: 0 }));
    player.stop("u1");
    expect(context.sources[0].stopped).toBe(true);
    expect(context.sources[1].stopped).toBe(true);
    expect(context.sources[2].stopped).toBe(false);
    context.sources[0].onended?.();
    expect(summary()).toEqual(["u1:0:started"]);
    player.stop(null);
    expect(context.sources[2].stopped).toBe(true);
    // A fresh utterance starts now rather than after the stopped queue.
    player.play(chunk({ utteranceId: "u3" }));
    expect(context.sources[3].startedAt).toBeCloseTo(10.03, 5);
  });

  test("an empty chunk still advances the utterance", () => {
    const { player, summary } = setup();
    player.play(chunk({ pcm: new Uint8Array(1) }));
    expect(summary()).toEqual(["u1:0:started", "u1:0:ended"]);
  });

  test("reports a failure when audio cannot be created", () => {
    const { player, events } = setup();
    player.play(chunk({ sampleRate: 1 }));
    expect(events).toEqual([
      {
        utteranceId: "u1",
        chunk: 0,
        event: "failed",
        message: "Could not play speech: Unsupported sample rate",
      },
    ]);
    const broken = createVoicePlayer(
      (event) => events.push(event),
      () => {
        throw new Error("No audio device");
      },
    );
    broken.play(chunk({ utteranceId: "u9" }));
    expect(events[1]).toMatchObject({ utteranceId: "u9", event: "failed" });
  });

  test("routes to the chosen output and falls back to the default", async () => {
    const { context, player } = setup();
    player.play(chunk({ outputDeviceId: "default" }));
    context.rejectSinks.add("speakers");
    player.play(chunk({ chunk: 1, outputDeviceId: "speakers" }));
    await tick();
    await tick();
    expect(context.sinks).toEqual(["", "speakers", ""]);
    expect(context.sources).toHaveLength(2);
  });

  test("dispose stops playback and closes the context", () => {
    const { context, player } = setup();
    player.play(chunk());
    player.dispose();
    expect(context.sources[0].stopped).toBe(true);
    expect(context.closed).toBe(true);
  });
});
