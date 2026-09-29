import captureWorkletUrl from "./captureWorklet.js?url&no-inline";
import { bridge } from "./bridge";
import { acquireCaptureInput, watchCaptureInput } from "./captureInput";
import { CaptureCuePlayer, type CaptureCue } from "./captureCues";
import { microphoneSelection } from "./microphoneSelection";
import { MAX_CAPTURE_DURATION_MS, MAX_CAPTURE_SAMPLES } from "./captureLimits";
import { CLIPPING_THRESHOLD } from "./captureDiagnostics";
import { beginCaptureLevel } from "./captureLevel";
import type { CaptureDiagnostics, MicrophoneDevice, RecorderCommand } from "./types";

function merge(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function resample(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16_000,
): Float32Array {
  if (!input.length || sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function wav(samples: Float32Array, sampleRate = 16_000): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return new Uint8Array(buffer);
}

function audibleLevel(rms: number): number {
  return Math.min(1, Math.max(0, rms * 4.2));
}

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private peakAmplitude = 0;
  private sumSquares = 0;
  private clippedSampleCount = 0;
  private liveLevel: ReturnType<typeof beginCaptureLevel> | null = null;

  constructor(private readonly onDiagnostics?: (stats: CaptureDiagnostics | null) => void) {}

  private capturedSamples = 0;
  private sampleLimit = MAX_CAPTURE_SAMPLES;
  private limitStopRequested = false;
  private captureLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private stopping = false;
  private lastLevelAt = 0;
  private generation = 0;
  private sessionId: string | null = null;
  private requestedSessionId: string | null = null;
  private readonly cuePlayer = new CaptureCuePlayer();
  private cueEpoch = 0;
  private commands: Promise<void> = Promise.resolve();
  private stopWatchingInput: (() => void) | null = null;

  async cancel(): Promise<void> {
    await this.handle({ action: "cancel", inputDeviceId: "default" });
    // Public cancellation also disposes the controller during unmount/reload.
    this.cueEpoch += 1;
    await this.cuePlayer.dispose();
  }

  handle(command: RecorderCommand): Promise<void> {
    let sessionId = command.sessionId;
    if (command.action === "start") {
      if (
        sessionId &&
        this.requestedSessionId &&
        sessionId !== this.requestedSessionId
      )
        return Promise.resolve();
      sessionId ??= this.requestedSessionId ?? crypto.randomUUID();
      if (sessionId !== this.requestedSessionId) {
        this.cueEpoch += 1;
        void this.cuePlayer.dispose().catch(() => undefined);
      }
      this.requestedSessionId = sessionId;
    } else {
      // A queued Start already owns the next generation while the abandoned
      // capture is still unwinding permission/flush/disposal. Old commands
      // must not invalidate that newer reservation.
      const owner = this.requestedSessionId ?? this.sessionId;
      sessionId ??= owner ?? undefined;
      if (sessionId && sessionId !== owner) return Promise.resolve();
      if (command.action === "cancel") {
        this.generation += 1;
        this.cueEpoch += 1;
        void this.cuePlayer.dispose().catch(() => undefined);
        if (!sessionId || this.requestedSessionId === sessionId)
          this.requestedSessionId = null;
      }
    }
    const generation = this.generation;
    const operation = this.commands.then(async () => {
      if (command.action === "start") {
        await this.start(command.inputDeviceId, generation, sessionId!);
      } else if (!sessionId || sessionId === this.sessionId) {
        if (command.action === "stop" && generation === this.generation)
          await this.stop(true, generation);
        if (command.action === "cancel") await this.stop(false, generation);
      }
    });
    this.commands = operation.catch(() => undefined);
    return operation;
  }

  private finishSession(sessionId: string): void {
    if (this.sessionId === sessionId) this.sessionId = null;
    if (this.requestedSessionId === sessionId) this.requestedSessionId = null;
  }

  private async start(
    deviceId: string,
    generation: number,
    sessionId: string,
  ): Promise<void> {
    if (this.stream || this.stopping || generation !== this.generation) return;
    const cueEpoch = this.cueEpoch;
    this.sessionId = sessionId;
    try {
      if (deviceId && deviceId !== "default") {
        // Discovery can be unavailable independently of capture permission.
        // In that case let getUserMedia check the exact saved input itself.
        const devices = await listMicrophones(false).catch(() => []);
        if (generation !== this.generation) return;
        const selection = microphoneSelection(
          { inputDeviceId: deviceId, inputDeviceLabel: "Selected microphone" },
          devices,
        );
        if (selection.state === "missing") throw new Error(selection.message!);
      }
      const input = await acquireCaptureInput(deviceId);
      const stream = input.stream;
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        this.finishSession(sessionId);
        return;
      }
      this.stream = stream;
      this.context = new AudioContext({ latencyHint: "interactive" });
      const track = stream.getAudioTracks()[0];
      if (track) this.liveLevel = beginCaptureLevel(track, this.context);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.chunks = [];
      this.sampleCount = 0;
      this.peakAmplitude = 0;
      this.sumSquares = 0;
      this.clippedSampleCount = 0;
      this.onDiagnostics?.(null);
      this.capturedSamples = 0;
      this.sampleLimit = Math.min(
        MAX_CAPTURE_SAMPLES,
        Math.floor((this.context.sampleRate * MAX_CAPTURE_DURATION_MS) / 1000),
      );
      this.limitStopRequested = false;
      if (await this.connectWorklet(generation)) {
        this.source.connect(this.worklet!);
        this.worklet!.connect(this.sink);
      } else {
        this.processor = this.context.createScriptProcessor(4096, 1, 1);
        const processor = this.processor;
        processor.onaudioprocess = (event) => {
          if (this.processor === processor && generation === this.generation)
            this.ingest(event.inputBuffer.getChannelData(0));
        };
        this.source.connect(this.processor);
        this.processor.connect(this.sink);
      }
      if (generation !== this.generation) {
        await this.dispose();
        this.finishSession(sessionId);
        return;
      }
      this.sink.connect(this.context.destination);
      this.startedAt = performance.now();
      this.captureLimitTimer = setTimeout(
        () => this.requestLimitStop(),
        MAX_CAPTURE_DURATION_MS,
      );
      await bridge.recordingStarted(sessionId);
      if (generation !== this.generation || this.sessionId !== sessionId)
        return;
      this.stopWatchingInput = watchCaptureInput(input, (event) => {
        if (
          generation !== this.generation ||
          this.sessionId !== sessionId ||
          this.stopping
        )
          return;
        const inputLost = event.kind === "input-lost";
        if (inputLost) {
          // Stop accepting packets before queuing the existing flush/submit
          // path. The audio captured from the original input is retained.
          this.source?.disconnect();
          this.stopWatchingInput?.();
          this.stopWatchingInput = null;
        }
        void bridge
          .recordingInputChanged(sessionId, event.message, inputLost)
          .then(() => {
            if (inputLost && generation === this.generation)
              return this.handle({
                action: "stop",
                inputDeviceId: deviceId,
                sessionId,
              });
          })
          .catch((error) => {
            // IPC failure must not leave a disconnected capture running.
            if (inputLost && generation === this.generation) {
              void this.handle({
                action: "cancel",
                inputDeviceId: deviceId,
                sessionId,
              }).catch(() => undefined);
              void bridge.recordingFailed(
                `Could not finish capture after microphone loss: ${error instanceof Error ? error.message : String(error)}`,
                sessionId,
              ).catch(() => undefined);
            }
          });
      });
      void this.playCue("start", sessionId, generation, cueEpoch);
    } catch (error) {
      await this.dispose();
      this.finishSession(sessionId);
      if (generation !== this.generation) return;
      await bridge.recordingFailed(
        `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`,
        sessionId,
      );
    }
  }

  private async connectWorklet(generation: number): Promise<boolean> {
    if (!this.context) return false;
    try {
      await this.context.audioWorklet.addModule(captureWorkletUrl);
      this.worklet = new AudioWorkletNode(this.context, "delulu-capture");
      const worklet = this.worklet;
      worklet.port.onmessage = (
        event: MessageEvent<{ samples: Float32Array; rms: number }>,
      ) => {
        if (this.worklet === worklet && generation === this.generation && event.data?.samples)
          this.ingest(event.data.samples, event.data.rms);
      };
      return true;
    } catch {
      this.worklet = null;
      return false;
    }
  }

  private ingest(samples: Float32Array, rms?: number): void {
    const remaining = this.sampleLimit - this.capturedSamples;
    if (remaining <= 0) return;
    const accepted = Math.min(samples.length, remaining);
    if (!accepted) return;
    this.chunks.push(new Float32Array(samples.subarray(0, accepted)));
    for (const sample of samples.subarray(0, accepted)) {
      const amplitude = Math.abs(sample);
      this.peakAmplitude = Math.max(this.peakAmplitude, amplitude);
      this.sumSquares += sample * sample;
      if (amplitude >= CLIPPING_THRESHOLD) this.clippedSampleCount += 1;
    }
    this.sampleCount += accepted;
    this.capturedSamples += accepted;
    if (this.capturedSamples >= this.sampleLimit) this.requestLimitStop();
    const now = performance.now();
    if (now - this.lastLevelAt < 50) return;
    this.lastLevelAt = now;
    let level = rms;
    if (level == null) {
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      level = Math.sqrt(sum / Math.max(1, samples.length));
    }
    bridge.recordingLevel(audibleLevel(level));
    this.liveLevel?.sample(level);
  }

  private async playCue(
    cue: CaptureCue,
    sessionId: string,
    generation: number,
    epoch: number,
  ): Promise<void> {
    try {
      const settings = await bridge.getSettings();
      if (
        settings.captureSoundsMuted !== false ||
        generation !== this.generation ||
        epoch !== this.cueEpoch ||
        (this.requestedSessionId && this.requestedSessionId !== sessionId)
      )
        return;
      await this.cuePlayer.play(cue, settings.captureSoundVolume);
    } catch {
      // Optional sound/permission failures never interrupt microphone ownership,
      // transcript processing, or delivery.
    }
  }

  private clearCaptureLimitTimer(): void {
    if (this.captureLimitTimer) clearTimeout(this.captureLimitTimer);
    this.captureLimitTimer = null;
  }

  private requestLimitStop(): void {
    if (!this.sessionId || this.stopping || this.limitStopRequested) return;
    this.limitStopRequested = true;
    this.clearCaptureLimitTimer();
    this.source?.disconnect();
    const sessionId = this.sessionId;
    const generation = this.generation;
    // Main must enter stopping ownership before the WAV can be committed.
    // The tagged callback cannot stop a newer capture after Cancel/reload.
    void bridge.recordingLimitReached(sessionId)
      .then(() => {
        if (generation !== this.generation) return;
        return this.handle({
          action: "stop",
          inputDeviceId: "default",
          sessionId,
        });
      })
      .catch((error) => {
        // Release bounded capture if its desktop controller cannot accept Stop.
        // A failure is visible instead of silently leaving the mic running.
        void this.handle({
          action: "cancel",
          inputDeviceId: "default",
          sessionId,
        }).catch(() => undefined);
        void bridge.recordingFailed(
          `Could not finish the recording at its limit: ${error instanceof Error ? error.message : String(error)}`,
          sessionId,
        ).catch(() => undefined);
      });
  }

  private async stop(submit: boolean, generation: number): Promise<void> {
    if (!this.stream || !this.context || this.stopping) return;
    const sessionId = this.sessionId!;
    this.stopping = true;
    this.stopWatchingInput?.();
    this.stopWatchingInput = null;
    this.cueEpoch += 1;
    void this.cuePlayer.dispose().catch(() => undefined);
    this.clearCaptureLimitTimer();
    try {
      const durationMs = Math.min(
        MAX_CAPTURE_DURATION_MS,
        Math.round(performance.now() - this.startedAt),
      );
      const sampleRate = this.context.sampleRate;
      this.source?.disconnect();
      if (this.worklet && submit) {
        const port = this.worklet.port;
        const receive = port.onmessage;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            port.onmessage = receive;
            resolve();
          };
          const timer = setTimeout(finish, 300);
          port.onmessage = (event) => {
            if (event.data?.flushed) finish();
            else receive?.call(port, event);
          };
          port.postMessage("flush");
        });
      }
      const captured = merge(this.chunks);
      const captureDiagnostics: CaptureDiagnostics = {
        sampleCount: this.sampleCount, sampleRate, peakAmplitude: this.peakAmplitude,
        rmsAmplitude: Math.min(this.peakAmplitude, Math.sqrt(this.sumSquares / Math.max(1, this.sampleCount))),
        clippedSampleCount: this.clippedSampleCount, clippingThreshold: CLIPPING_THRESHOLD,
      };
      this.chunks = [];
      await this.dispose();
      // End cues use a separate output context only after microphone release.
      void this.playCue("stop", sessionId, this.generation, this.cueEpoch);
      if (submit && generation === this.generation) {
        this.onDiagnostics?.(captured.length ? captureDiagnostics : null);
        if (!captured.length) {
          const failure = bridge.recordingFailed(
            "The microphone did not produce audio. Try another input.",
            sessionId,
          );
          this.finishSession(sessionId);
          this.stopping = false;
          await failure;
          return;
        }
        const delivery = bridge.submitRecording({
          sessionId,
          wav: wav(resample(captured, sampleRate)),
          durationMs,
          captureDiagnostics,
        });
        // Capture is committed to desktop ownership. Accept a later Start even
        // if the IPC reply still waits for completed inference/delivery.
        this.finishSession(sessionId);
        this.stopping = false;
        await delivery;
      }
    } finally {
      this.stopping = false;
      this.finishSession(sessionId);
    }
  }

  private async dispose(): Promise<void> {
    this.stopWatchingInput?.();
    this.stopWatchingInput = null;
    this.liveLevel?.stop();
    this.liveLevel = null;
    this.clearCaptureLimitTimer();
    if (this.worklet) this.worklet.port.onmessage = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed")
      await this.context.close();
    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.chunks = [];
    this.capturedSamples = 0;
    this.limitStopRequested = false;
    this.lastLevelAt = 0;
  }
}

export async function listMicrophones(
  requestPermission = false,
): Promise<MicrophoneDevice[]> {
  let temporary: MediaStream | null = null;
  if (requestPermission) {
    try {
      temporary = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      /* labels may remain private */
    }
  }
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } finally {
    temporary?.getTracks().forEach((track) => track.stop());
  }
  const microphones = devices.filter((device) => device.kind === "audioinput");
  let inventoryKnown = microphones.some((device) => !!device.label);
  if (!inventoryKnown && navigator.permissions) {
    try {
      inventoryKnown =
        (
          await navigator.permissions.query({
            name: "microphone" as PermissionName,
          })
        ).state === "granted";
    } catch {
      // Some browsers do not expose microphone permission through this API.
    }
  }
  return [
    { deviceId: "default", label: "System default", labelKnown: inventoryKnown },
    ...microphones
      .filter((device) => device.deviceId && device.deviceId !== "default")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
        labelKnown: !!device.label,
      })),
  ];
}
