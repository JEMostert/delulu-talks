import { identifySyntheticMicrophone } from "./syntheticMicrophone";
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

test("100 sessions reuse one recorder without leaked resources or lost final samples", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(150_000);
  await identifySyntheticMicrophone(page);
  mkdirSync("artifacts", { recursive: true });
  const directory = mkdtempSync(join("artifacts", "capture-stress-"));
  try {
    // Gate real microphone quanta, leaving production buffering/flush unchanged.
    // Vary the length each session so stale samples cannot pass the WAV oracle.
    await page.exposeFunction("stressFixtureModule", (source: string) => {
      writeFileSync(
        join(directory, "worklet.js"),
        `{
          const registerProcessor = (name, Processor) => globalThis.registerProcessor(name,
            class extends Processor {
              constructor(options) {
                super(options);
                this.limit = options.processorOptions.quanta;
                this.quanta = 0;
              }
              process(inputs) {
                if (this.quanta >= this.limit) return true;
                const channel = inputs[0] && inputs[0][0];
                if (!this.started) {
                  if (!channel || !channel.some(sample => sample !== 0)) return true;
                  this.started = true;
                }
                const running = super.process(inputs);
                if (channel && ++this.quanta === this.limit)
                  this.port.postMessage({ captureLimitReached: true });
                return running;
              }
            });
          ${source}
        }`,
      );
      return `/artifacts/${basename(directory)}/worklet.js`;
    });
    await context.grantPermissions(["microphone"]);
    await page.goto("/");
    await page.getByRole("button", { name: "Dismiss setup" }).click();
    const report = await page.evaluate(async () => {
      const { PcmRecorder } = await import(
        /* @vite-ignore */ "/src/recorder.ts"
      );
      const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
      const NativeContext = window.AudioContext;
      const NativeWorklet = window.AudioWorkletNode;
      const getUserMedia = navigator.mediaDevices.getUserMedia;
      const originalBridge = {
        recordingStarted: bridge.recordingStarted,
        recordingLevel: bridge.recordingLevel,
        recordingFailed: bridge.recordingFailed,
        submitRecording: bridge.submitRecording,
      };
      const contexts: AudioContext[] = [];
      const streams: MediaStream[] = [];
      const nodes: { node: AudioNode; disconnected: boolean }[] = [];
      const worklets: AudioWorkletNode[] = [];
      const failures: string[] = [];
      const sessions: {
        index: number;
        quanta: number;
        packets: Float32Array[];
        flushRequested: boolean;
        flushAcknowledged: boolean;
        started: number;
        submissions: number;
        audio?: Uint8Array;
        releasedAtSubmission?: boolean;
      }[] = [];
      let current: (typeof sessions)[number];
      let captureReady: () => void;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fixtureUrl: string | undefined;
      const observe = <T extends AudioNode>(node: T): T => {
        const resource = { node, disconnected: false };
        nodes.push(resource);
        const disconnect = node.disconnect.bind(node);
        node.disconnect = () => {
          disconnect();
          resource.disconnected = true;
        };
        return node;
      };
      const released = () =>
        streams.every((stream) =>
          stream.getTracks().every((track) => track.readyState === "ended"),
        ) &&
        contexts.every((context) => context.state === "closed") &&
        nodes.every((resource) => resource.disconnected) &&
        worklets.every((node) => node.port.onmessage === null);
      window.AudioContext = class extends NativeContext {
        constructor(options?: AudioContextOptions) {
          super({ ...options, sampleRate: 16_000 });
          contexts.push(this);
          const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
          this.audioWorklet.addModule = async (url, options) => {
            if (!fixtureUrl) {
              const response = await fetch(url);
              if (!response.ok)
                throw new Error("Production worklet unavailable");
              fixtureUrl = await (
                window as unknown as {
                  stressFixtureModule(source: string): Promise<string>;
                }
              ).stressFixtureModule(await response.text());
            }
            await addModule(fixtureUrl, options);
          };
        }
        createMediaStreamSource(stream: MediaStream) {
          return observe(super.createMediaStreamSource(stream));
        }
        createGain() {
          return observe(super.createGain());
        }
      };
      window.AudioWorkletNode = class extends NativeWorklet {
        constructor(
          context: BaseAudioContext,
          name: string,
          options?: AudioWorkletNodeOptions,
        ) {
          super(context, name, {
            ...options,
            processorOptions: { quanta: current.quanta },
          });
          observe(this);
          worklets.push(this);
          const session = current;
          const ready = captureReady;
          this.addEventListener("processorerror", () =>
            failures.push(`Session ${session.index}: processorerror`),
          );
          const postMessage = this.port.postMessage.bind(this.port);
          this.port.postMessage = (message: unknown) => {
            if (message === "flush") session.flushRequested = true;
            postMessage(message);
          };
          this.port.addEventListener("message", (event) => {
            if (event.data.samples)
              session.packets.push(new Float32Array(event.data.samples));
            if (event.data.flushed) session.flushAcknowledged = true;
            if (event.data.captureLimitReached) ready();
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
        current.started += 1;
        await contexts.at(-1)!.resume();
      };
      bridge.recordingLevel = () => {};
      bridge.recordingFailed = async (message: string) => {
        failures.push(`Session ${current.index}: ${message}`);
      };
      bridge.submitRecording = async (value: { wav: Uint8Array }) => {
        current.submissions += 1;
        current.audio = value.wav;
        current.releasedAtSubmission = released();
      };
      const recorder = new PcmRecorder();
      const results = [];
      try {
        for (let index = 0; index < 100; index += 1) {
          current = {
            index,
            quanta: 17 + (index % 5),
            packets: [],
            flushRequested: false,
            flushAcknowledged: false,
            started: 0,
            submissions: 0,
          };
          sessions.push(current);
          const ready = new Promise<void>((resolve) => {
            captureReady = resolve;
          });
          const releasedBeforeStart = released();
          const start = () =>
            recorder.handle({
              action: "start",
              inputDeviceId: "fixture-microphone",
            });
          await Promise.all(index % 10 === 0 ? [start(), start()] : [start()]);
          await Promise.race([
            ready,
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Session ${index}: microphone/worklet deadline; ${failures.join("; ")}`,
                    ),
                  ),
                5000,
              );
            }),
          ]);
          clearTimeout(timer);
          const liveBeforeStop = streams
            .at(-1)!
            .getTracks()
            .every((track) => track.readyState === "live");
          const stop = () =>
            recorder.handle({
              action: "stop",
              inputDeviceId: "fixture-microphone",
            });
          await Promise.all(index % 10 === 0 ? [stop(), stop()] : [stop()]);
          const audio = current.audio ?? new Uint8Array(44);
          const view = new DataView(
            audio.buffer,
            audio.byteOffset,
            audio.byteLength,
          );
          const samples = current.packets.flatMap((packet) =>
            Array.from(packet),
          );
          const deliveredSamples = (audio.length - 44) / 2;
          const exactPayload =
            deliveredSamples === samples.length &&
            samples.every((sample, offset) => {
              const clamped = Math.max(-1, Math.min(1, sample));
              return (
                view.getInt16(44 + offset * 2, true) ===
                Math.trunc(clamped * (clamped < 0 ? 32768 : 32767))
              );
            });
          const result = {
            session: index + 1,
            expectedSamples: current.quanta * 128,
            deliveredSamples,
            packetSizes: current.packets.map((packet) => packet.length),
            finalSamples: current.packets.at(-1)?.length ?? 0,
            expectedFinalSamples: (current.quanta - 16) * 128,
            exactPayload,
            nonSilent: samples.some((sample) => sample !== 0),
            started: current.started,
            submissions: current.submissions,
            liveBeforeStop,
            releasedBeforeStart,
            releasedBeforeSubmission: current.releasedAtSubmission === true,
            releasedAfterStop: released(),
            flushRequested: current.flushRequested,
            flushAcknowledged: current.flushAcknowledged,
            resourcesCreated:
              streams.length === index + 1 &&
              contexts.length === index + 1 &&
              worklets.length === index + 1 &&
              nodes.length === (index + 1) * 3,
            validWav:
              String.fromCharCode(...audio.slice(0, 4)) === "RIFF" &&
              String.fromCharCode(...audio.slice(8, 12)) === "WAVE" &&
              view.getUint32(24, true) === 16_000 &&
              view.getUint16(22, true) === 1 &&
              view.getUint16(34, true) === 16 &&
              view.getUint32(40, true) === audio.length - 44,
          };
          results.push(result);
          // Detect failures before the next session or emergency finally cleanup.
          if (
            failures.length ||
            !exactPayload ||
            deliveredSamples !== result.expectedSamples ||
            result.finalSamples !== result.expectedFinalSamples ||
            result.started !== 1 ||
            result.submissions !== 1 ||
            Object.entries(result).some(([, value]) => value === false)
          )
            throw new Error(JSON.stringify({ result, failures }));
          // Keep the stress harness itself from retaining every audio payload.
          current.audio = undefined;
          current.packets = [];
        }
        return {
          sessions: results,
          failures,
          submissions: sessions.reduce(
            (total, session) => total + session.submissions,
            0,
          ),
        };
      } finally {
        clearTimeout(timer);
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
        Object.assign(bridge, originalBridge);
      }
    });
    await testInfo.attach("capture-stress-report", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    expect(report.failures).toEqual([]);
    expect(report.sessions).toHaveLength(100);
    expect(report.submissions).toBe(100);
    for (const session of report.sessions) {
      expect(session.packetSizes, `Session ${session.session}`).toEqual([
        2048,
        session.expectedFinalSamples,
      ]);
      expect(session.deliveredSamples).toBe(session.expectedSamples);
      expect(session.exactPayload).toBe(true);
      expect(session.releasedBeforeSubmission).toBe(true);
      expect(session.releasedAfterStop).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
