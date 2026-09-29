import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const fixtureDirectories: string[] = [];
test.afterEach(() => {
  for (const path of fixtureDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

// Real Chromium microphone/Web Audio; only the desktop IPC destination is stubbed.
test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss setup" }).click();
});

test("stop delivers the final partial worklet batch before releasing capture", async ({
  page,
}) => {
  mkdirSync("artifacts", { recursive: true });
  const directory = mkdtempSync(join("artifacts", "capture-worklet-"));
  fixtureDirectories.push(directory);
  await page.exposeFunction("captureFixtureModule", (source: string) => {
    const fixture = `{
      const registerProcessor = (name, Processor) => globalThis.registerProcessor(name,
        class extends Processor {
          constructor() { super(); this.fixtureQuanta = 0; }
          process(inputs) {
            if (this.fixtureQuanta >= 17) return true;
            const channel = inputs[0] && inputs[0][0];
            // Chromium's fake input starts with silence; wait for its signal.
            if (!this.fixtureStarted) {
              if (!channel || !channel.some(sample => sample !== 0)) return true;
              this.fixtureStarted = true;
            }
            const running = super.process(inputs);
            if (channel && ++this.fixtureQuanta === 17)
              this.port.postMessage({ captureLimitReached: true });
            return running;
          }
        });
      ${source}
    }`;
    writeFileSync(join(directory, "worklet.js"), fixture);
    return `/artifacts/${basename(directory)}/worklet.js`;
  });
  const result = await page.evaluate(async () => {
    const { PcmRecorder } = await import(/* @vite-ignore */ "/src/recorder.ts");
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    const NativeContext = window.AudioContext;
    const NativeWorklet = window.AudioWorkletNode;
    const getUserMedia = navigator.mediaDevices.getUserMedia;
    const contexts: AudioContext[] = [];
    const streams: MediaStream[] = [];
    const packets: Float32Array[] = [];
    const finalPackets: Float32Array[] = [];
    const failures: string[] = [];
    const workletErrors: string[] = [];
    let flushRequested = false;
    let flushAcknowledged = false;
    let submissions = 0;
    let captureReleasedAtSubmission = false;
    let audio = new Uint8Array();
    let fixtureTimer: ReturnType<typeof setTimeout> | undefined;
    let captureLimitReached!: () => void;
    const capturedFixture = new Promise<void>((resolve) => {
      captureLimitReached = resolve;
    });
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        // Real 16 kHz capture allows a direct PCM oracle without resampling.
        super({ ...options, sampleRate: 16_000 });
        contexts.push(this);
        const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = async (url, options) => {
          try {
            const response = await fetch(url);
            if (!response.ok)
              throw new Error(`Worklet asset unavailable: ${response.status}`);
            const moduleUrl = await (
              window as unknown as {
                captureFixtureModule(source: string): Promise<string>;
              }
            ).captureFixtureModule(await response.text());
            await addModule(moduleUrl, options);
          } catch (error) {
            workletErrors.push(String(error));
            throw error;
          }
        };
      }
    };
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(context, name, options);
        this.addEventListener("processorerror", () =>
          workletErrors.push("processorerror"),
        );
        const postMessage = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message: unknown) => {
          if (message === "flush") flushRequested = true;
          postMessage(message);
        };
        this.port.addEventListener("message", (event) => {
          if (event.data.samples) {
            const samples = new Float32Array(event.data.samples);
            packets.push(samples);
            if (flushRequested) finalPackets.push(samples);
          }
          if (event.data.captureLimitReached) captureLimitReached();
          if (event.data.flushed) flushAcknowledged = true;
        });
        this.port.start();
      }
    };
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await getUserMedia.call(this, constraints);
      streams.push(stream);
      return stream;
    };
    bridge.recordingStarted = async () => {
      await contexts.at(-1)!.resume();
    };
    bridge.recordingLevel = () => {};
    bridge.recordingFailed = async (message: string) => {
      failures.push(message);
    };
    bridge.submitRecording = async (value: { wav: Uint8Array }) => {
      submissions += 1;
      audio = value.wav;
      captureReleasedAtSubmission =
        streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ) && contexts.every((context) => context.state === "closed");
    };
    const recorder = new PcmRecorder();
    try {
      await recorder.handle({ action: "start", inputDeviceId: "default" });
      await Promise.race([
        capturedFixture,
        new Promise(
          (_, reject) =>
            (fixtureTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    JSON.stringify({
                      failures,
                      workletErrors,
                      states: contexts.map((context) => context.state),
                      packets: packets.length,
                    }),
                  ),
                ),
              5000,
            )),
        ),
      ]);
      clearTimeout(fixtureTimer);
      await recorder.handle({ action: "stop", inputDeviceId: "default" });
      // A repeated Stop must not submit an already delivered capture again.
      await recorder.handle({ action: "stop", inputDeviceId: "default" });
      const view = new DataView(
        audio.buffer,
        audio.byteOffset,
        audio.byteLength,
      );
      const deliveredSamples = (audio.length - 44) / 2;
      const capturedSamples = packets.reduce(
        (total, packet) => total + packet.length,
        0,
      );
      const tail = finalPackets.at(-1) ?? new Float32Array();
      const tailOffset = deliveredSamples - tail.length;
      const exactTail = Array.from(tail).every((sample, index) => {
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = Math.trunc(clamped * (clamped < 0 ? 32768 : 32767));
        return view.getInt16(44 + (tailOffset + index) * 2, true) === pcm;
      });
      const samples = packets.flatMap((packet) => Array.from(packet));
      const exactPayload = samples.every((sample, index) => {
        const clamped = Math.max(-1, Math.min(1, sample));
        return (
          view.getInt16(44 + index * 2, true) ===
          Math.trunc(clamped * (clamped < 0 ? 32768 : 32767))
        );
      });
      return {
        failures,
        submissions,
        captureReleasedAtSubmission,
        flushRequested,
        flushAcknowledged,
        capturedSamples,
        deliveredSamples,
        tailSamples: tail.length,
        exactTail,
        exactPayload,
        header: String.fromCharCode(...audio.slice(0, 4)),
        sampleRate: view.getUint32(24, true),
        channels: view.getUint16(22, true),
        bitsPerSample: view.getUint16(34, true),
        dataBytes: view.getUint32(40, true),
        audioBytes: audio.length,
        nonSilent: packets.some((packet) =>
          packet.some((sample) => sample !== 0),
        ),
        streams: streams.length,
        contexts: contexts.length,
        packetSizes: packets.map((packet) => packet.length),
      };
    } finally {
      clearTimeout(fixtureTimer);
      await recorder.cancel();
      streams.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      await Promise.all(
        contexts
          .filter((context) => context.state !== "closed")
          .map((context) => context.close()),
      );
      window.AudioContext = NativeContext;
      window.AudioWorkletNode = NativeWorklet;
      navigator.mediaDevices.getUserMedia = getUserMedia;
    }
  });
  expect(result.failures).toEqual([]);
  expect(result.submissions).toBe(1);
  expect(result.streams).toBe(1);
  expect(result.contexts).toBe(1);
  expect(result.captureReleasedAtSubmission).toBe(true);
  expect(result.flushRequested).toBe(true);
  expect(result.flushAcknowledged).toBe(true);
  expect(result.packetSizes).toEqual([2048, 128]);
  expect(result.tailSamples).toBe(128);
  expect(result.capturedSamples).toBe(2176);
  expect(result.deliveredSamples).toBe(result.capturedSamples);
  expect(result.exactTail).toBe(true);
  expect(result.exactPayload).toBe(true);
  expect(result.nonSilent).toBe(true);
  expect(result.header).toBe("RIFF");
  expect(result.sampleRate).toBe(16_000);
  expect(result.channels).toBe(1);
  expect(result.bitsPerSample).toBe(16);
  expect(result.dataBytes).toBe(result.audioBytes - 44);
});

test("unmodified worklet stops and repeated cancel releases capture without extra submissions", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { PcmRecorder } = await import(/* @vite-ignore */ "/src/recorder.ts");
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    const NativeContext = window.AudioContext;
    const NativeWorklet = window.AudioWorkletNode;
    const getUserMedia = navigator.mediaDevices.getUserMedia;
    const contexts: AudioContext[] = [];
    const streams: MediaStream[] = [];
    const failures: string[] = [];
    let started = 0;
    let submissions = 0;
    let nodes = 0;
    let observedSamples = 0;
    let flushAcknowledged = false;
    let submittedAudio = new Uint8Array();
    let releasedAtSubmission = false;
    let audioReady!: () => void;
    const heardAudio = new Promise<void>((resolve) => {
      audioReady = resolve;
    });
    let audioTimer: ReturnType<typeof setTimeout> | undefined;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    };
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(context, name, options);
        nodes += 1;
        this.addEventListener("processorerror", () =>
          failures.push("processorerror"),
        );
        this.port.addEventListener("message", (event) => {
          if (event.data.samples) {
            observedSamples += event.data.samples.length;
            if (event.data.samples.some((sample: number) => sample !== 0))
              audioReady();
          }
          if (event.data.flushed) flushAcknowledged = true;
        });
        this.port.start();
      }
    };
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await getUserMedia.call(this, constraints);
      streams.push(stream);
      return stream;
    };
    bridge.recordingStarted = async () => {
      started += 1;
      await contexts.at(-1)!.resume();
    };
    bridge.recordingLevel = () => {};
    bridge.recordingFailed = async (message: string) => {
      failures.push(message);
    };
    bridge.submitRecording = async (value: { wav: Uint8Array }) => {
      submissions += 1;
      submittedAudio = value.wav;
      releasedAtSubmission =
        streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ) && contexts.every((context) => context.state === "closed");
    };
    const recorder = new PcmRecorder();
    try {
      await recorder.handle({ action: "start", inputDeviceId: "default" });
      await Promise.race([
        heardAudio,
        new Promise((_, reject) => {
          audioTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "Unmodified worklet did not deliver microphone audio",
                ),
              ),
            5000,
          );
        }),
      ]);
      clearTimeout(audioTimer);
      await recorder.handle({ action: "stop", inputDeviceId: "default" });
      const normal = {
        sampleRate: new DataView(submittedAudio.buffer).getUint32(24, true),
        deliveredSamples: (submittedAudio.length - 44) / 2,
        expectedSamples: Math.round(
          (observedSamples * 16_000) / contexts[0].sampleRate,
        ),
        releasedAtSubmission,
        flushAcknowledged,
      };
      const cycles = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await recorder.handle({ action: "start", inputDeviceId: "default" });
        const live = streams
          .at(-1)!
          .getTracks()
          .every((track) => track.readyState === "live");
        await recorder.cancel();
        await recorder.handle({ action: "stop", inputDeviceId: "default" });
        cycles.push({
          live,
          ended: streams
            .at(-1)!
            .getTracks()
            .every((track) => track.readyState === "ended"),
          closed: contexts.at(-1)!.state === "closed",
        });
      }
      return {
        cycles,
        started,
        submissions,
        failures,
        streams: streams.length,
        contexts: contexts.length,
        nodes,
        normal,
      };
    } finally {
      clearTimeout(audioTimer);
      await recorder.cancel();
      streams.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      await Promise.all(
        contexts
          .filter((context) => context.state !== "closed")
          .map((context) => context.close()),
      );
      window.AudioContext = NativeContext;
      window.AudioWorkletNode = NativeWorklet;
      navigator.mediaDevices.getUserMedia = getUserMedia;
    }
  });
  expect(result.failures).toEqual([]);
  expect(result.started).toBe(4);
  expect(result.streams).toBe(4);
  expect(result.contexts).toBe(4);
  expect(result.nodes).toBe(4);
  expect(result.submissions).toBe(1);
  expect(result.normal.sampleRate).toBe(16_000);
  expect(result.normal.deliveredSamples).toBeGreaterThan(0);
  expect(result.normal.deliveredSamples).toBe(result.normal.expectedSamples);
  expect(result.normal.flushAcknowledged).toBe(true);
  expect(result.normal.releasedAtSubmission).toBe(true);
  expect(result.cycles).toEqual(
    Array.from({ length: 3 }, () => ({
      live: true,
      ended: true,
      closed: true,
    })),
  );
});
