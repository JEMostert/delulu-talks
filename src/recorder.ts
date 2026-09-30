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

type CaptureSession = {
  readonly generation: number;
  readonly sessionId: string;
  sampleCount: number; peakAmplitude: number; sumSquares: number; clippedSampleCount: number;
  sampleLimit: number; limitStopRequested: boolean;
  limitTimer?: ReturnType<typeof setTimeout>;
  stopWatchingInput?: () => void;
  liveLevel?: ReturnType<typeof beginCaptureLevel>;
  context: AudioContext | null;
  stream: MediaStream | null;
  worklet: AudioWorkletNode | null;
  processor: ScriptProcessorNode | null;
  source: MediaStreamAudioSourceNode | null;
  sink: GainNode | null;
  chunks: Float32Array[];
  startedAt: number;
  lastLevelAt: number;
  stopping: boolean;
  paused: boolean;
  cancelled: boolean;
  readonly cancellation: Promise<void>;
  cancel: () => void;
  finishFlush?: () => void;
  disposal?: Promise<void>;
};

export class PcmRecorder {
  private session: CaptureSession | null = null;
  private generation = 0;
  private requestedSessionId: string | null = null;
  private cueEpoch = 0;
  private cuePlayer = new CaptureCuePlayer();
  constructor(private readonly onDiagnostics?: (stats: CaptureDiagnostics | null) => void) {}
  private commands: Promise<void> = Promise.resolve();

  async cancel(): Promise<void> {
    await this.handle({ action: "cancel", inputDeviceId: "default" });
  }

  handle(command: RecorderCommand): Promise<void> {
    let sessionId = command.sessionId;
    if (command.action === "start") {
      if (sessionId && this.requestedSessionId && sessionId !== this.requestedSessionId) return Promise.resolve();
      sessionId ??= this.requestedSessionId ?? crypto.randomUUID();
      this.requestedSessionId = sessionId;
    } else {
      const owner = this.requestedSessionId ?? this.session?.sessionId;
      sessionId ??= owner;
      if (sessionId && owner && sessionId !== owner) return Promise.resolve();
    }
    command = { ...command, sessionId };
    if (command.action === "cancel") {
      this.generation += 1;
      this.requestedSessionId = null;
      this.cueEpoch += 1;
      void this.cuePlayer.dispose().catch(() => undefined);
      const session = this.session;
      if (session) {
        // Invalidate immediately, including while acquisition or flush awaits.
        session.cancelled = true;
        session.cancel();
        session.finishFlush?.();
        void this.dispose(session);
      }
    }
    const generation = this.generation;
    const operation = this.commands.then(async () => {
      if (command.action === "start")
        await this.start(command.inputDeviceId, generation, command.sessionId!);
      if (command.action === "pause" || command.action === "resume")
        await this.changePause(command.action === "pause", command.sessionId);
      if (command.action === "stop") await this.stop(true, command.sessionId);
      if (command.action === "cancel") await this.stop(false, command.sessionId);
    });
    this.commands = operation.catch(() => undefined);
    return operation;
  }

  private current(session: CaptureSession): boolean {
    return (
      this.session === session &&
      !session.cancelled &&
      session.generation === this.generation &&
      !session.disposal
    );
  }

  private async start(deviceId: string, generation: number, sessionId: string): Promise<void> {
    if (this.session || generation !== this.generation) return;
    let cancel!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancel = resolve; });
    const session: CaptureSession = {
      generation, sessionId, cancellation, cancel,
      sampleCount: 0, peakAmplitude: 0, sumSquares: 0, clippedSampleCount: 0, sampleLimit: MAX_CAPTURE_SAMPLES, limitStopRequested: false,
      context: null, stream: null, worklet: null, processor: null,
      source: null, sink: null, chunks: [], startedAt: 0, lastLevelAt: 0,
      stopping: false, paused: false, cancelled: false,
    };
    this.session = session;
    try {
      const acquisition = acquireCaptureInput(deviceId).then((input) => {
        if (!this.current(session)) { input.stream.getTracks().forEach((track) => track.stop()); return null; }
        session.stream = input.stream;
        return input;
      });
      const input = await Promise.race([
        acquisition,
        session.cancellation.then(() => null),
      ]);
      if (!input || !this.current(session)) return;
      const stream = input.stream;
      const context = new AudioContext({ latencyHint: "interactive" });
      session.context = context;
      const track = stream.getAudioTracks()[0];
      if (track) session.liveLevel = beginCaptureLevel(track, context);
      session.sampleLimit = Math.min(MAX_CAPTURE_SAMPLES, Math.floor(context.sampleRate * MAX_CAPTURE_DURATION_MS / 1000));
      this.onDiagnostics?.(null);
      session.source = context.createMediaStreamSource(stream);
      session.sink = context.createGain();
      session.sink.gain.value = 0;
      const connected = await this.connectWorklet(session);
      if (!this.current(session)) return;
      if (connected) {
        session.source.connect(session.worklet!);
        session.worklet!.connect(session.sink);
      } else {
        session.processor = context.createScriptProcessor(4096, 1, 1);
        session.processor.onaudioprocess = (event) =>
          this.ingest(session, event.inputBuffer.getChannelData(0));
        session.source.connect(session.processor);
        session.processor.connect(session.sink);
      }
      session.sink.connect(context.destination);
      session.startedAt = performance.now();
      await Promise.race([bridge.recordingStarted(session.sessionId), session.cancellation]);
      if (!this.current(session)) return;
      session.limitTimer = setTimeout(() => this.requestLimitStop(session), MAX_CAPTURE_DURATION_MS);
      session.stopWatchingInput = watchCaptureInput(input, (event) => {
        if (!this.current(session) || session.stopping) return;
        const lost = event.kind === "input-lost";
        if (lost) session.source?.disconnect();
        void bridge.recordingInputChanged(session.sessionId, event.message, lost).then(() => {
          if (lost && this.current(session)) return this.handle({action:"stop",inputDeviceId:deviceId,sessionId:session.sessionId});
        }).catch((error) => {
          if (!lost || !this.current(session)) return;
          void this.handle({action:"cancel",inputDeviceId:deviceId,sessionId:session.sessionId});
          void bridge.recordingFailed(String(error),session.sessionId).catch(() => undefined);
        });
      });
      void this.playCue("start",session.sessionId,session.generation,this.cueEpoch);
    } catch (error) {
      const report = this.current(session);
      await this.dispose(session);
      if (!report || session.cancelled || generation !== this.generation) return;
      await bridge.recordingFailed(
        `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`, session.sessionId,
      );
    }
  }

  private async connectWorklet(session: CaptureSession): Promise<boolean> {
    const context = session.context;
    if (!context) return false;
    try {
      await Promise.race([
        context.audioWorklet.addModule(captureWorkletUrl),
        session.cancellation,
      ]);
      if (!this.current(session)) return false;
      session.worklet = new AudioWorkletNode(context, "delulu-capture");
      session.worklet.port.onmessage = (
        event: MessageEvent<{ samples: Float32Array; rms: number }>,
      ) => {
        if (event.data?.samples)
          this.ingest(session, event.data.samples, event.data.rms);
      };
      return true;
    } catch {
      session.worklet = null;
      return false;
    }
  }

  private ingest(session: CaptureSession, samples: Float32Array, rms?: number): void {
    // Messages queued by a detached worklet and fallback callbacks can outlive
    // resource disposal. They can only append to their original live session.
    if (!this.current(session) || session.paused) return;
    const accepted = Math.min(samples.length, session.sampleLimit - session.sampleCount);
    if (accepted <= 0) return;
    samples = samples.subarray(0,accepted);
    session.chunks.push(new Float32Array(samples));
    for (const sample of samples) {
      session.peakAmplitude = Math.max(session.peakAmplitude, Math.abs(sample));
      session.sumSquares += sample * sample;
      if (Math.abs(sample) >= CLIPPING_THRESHOLD) session.clippedSampleCount += 1;
    }
    session.sampleCount += accepted;
    if (session.sampleCount >= session.sampleLimit) this.requestLimitStop(session);
    const now = performance.now();
    if (now - session.lastLevelAt < 50) return;
    session.lastLevelAt = now;
    let level = rms;
    if (level == null) {
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      level = Math.sqrt(sum / Math.max(1, samples.length));
    }
    bridge.recordingLevel(audibleLevel(level));
    session.liveLevel?.sample(level);
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

  private requestLimitStop(session: CaptureSession): void {
    if (!this.current(session) || session.stopping || session.limitStopRequested) return;
    session.limitStopRequested = true;
    clearTimeout(session.limitTimer);
    session.source?.disconnect();
    void bridge.recordingLimitReached(session.sessionId).then(() => {
      if (this.current(session)) return this.handle({action:"stop", inputDeviceId:"default", sessionId:session.sessionId});
    }).catch((error) => {
      if (!this.current(session)) return;
      void this.handle({action:"cancel", inputDeviceId:"default", sessionId:session.sessionId});
      void bridge.recordingFailed(String(error),session.sessionId).catch(() => undefined);
    });
  }

  private async changePause(paused: boolean, sessionId?: string): Promise<void> {
    const session = this.session;
    if (!session || !this.current(session) || session.stopping || !session.context ||
        (sessionId && session.sessionId !== sessionId) || session.paused === paused) return;
    if (!paused) session.paused = false;
    const port = session.worklet?.port;
    const receive = port?.onmessage;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const control = port ? new Promise<void>((resolve) => {
        // The acknowledgement follows all pre-pause samples on the same port.
        port.onmessage = (event) => {
          if (event.data?.pauseChanged === paused) resolve();
          else receive?.call(port, event);
        };
        port.postMessage({ action: paused ? "pause" : "resume" });
      }) : paused ? session.context.suspend() : session.context.resume();
      await Promise.race([control, session.cancellation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pause/resume acknowledgement timed out")), 2000);
      })]);
    } catch (reason) {
      if (port) port.onmessage = this.current(session) ? receive ?? null : null;
      // An uncertain pause boundary cannot continue as if successful. Finalize
      // the retained audio through the existing stop path instead of dropping it.
      if (this.current(session)) await this.stop(true, session.sessionId);
      throw new Error(`${reason instanceof Error ? reason.message : String(reason)}. Recording was stopped to preserve retained audio.`);
    } finally {
      if (timer) clearTimeout(timer);
      if (port && this.current(session)) port.onmessage = receive ?? null;
    }
    if (!this.current(session)) return;
    session.paused = paused;
    bridge.recordingLevel(0);
    if (session.sessionId) await bridge.recordingPauseChanged(session.sessionId, paused);
  }

  private async stop(submit: boolean, sessionId?: string): Promise<void> {
    const session = this.session;
    if (!session || (sessionId && session.sessionId !== sessionId)) return;
    if (!submit) {
      session.cancelled = true;
      session.cancel();
      session.finishFlush?.();
      await this.dispose(session);
      return;
    }
    if (
      !this.current(session) ||
      !session.stream ||
      !session.context ||
      session.stopping
    )
      return;
    session.stopping = true;
    clearTimeout(session.limitTimer);
    session.stopWatchingInput?.();
    this.cueEpoch += 1;
    void this.cuePlayer.dispose().catch(() => undefined);
    // Duration describes retained audio, excluding paused wall-clock time.

    const sampleRate = session.context.sampleRate;
    try {
      session.source?.disconnect();
      if (session.worklet) {
        const port = session.worklet.port;
        const receive = port.onmessage;
        await new Promise<void>((resolve) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            session.finishFlush = undefined;
            port.onmessage = this.current(session) ? receive : null;
            resolve();
          };
          const timer = setTimeout(finish, 300);
          session.finishFlush = finish;
          port.onmessage = (event) => {
            if (event.data?.flushed) finish();
            else receive?.call(port, event);
          };
          try {
            port.postMessage("flush");
          } catch {
            finish();
          }
        });
      }
      if (!this.current(session)) return;
      const captured = merge(session.chunks);
      const durationMs = Math.round(captured.length / sampleRate * 1000);
      const captureDiagnostics: CaptureDiagnostics = {
        sampleCount:session.sampleCount, sampleRate, peakAmplitude:session.peakAmplitude,
        rmsAmplitude:Math.min(session.peakAmplitude,Math.sqrt(session.sumSquares / Math.max(1,session.sampleCount))),
        clippedSampleCount:session.clippedSampleCount, clippingThreshold:CLIPPING_THRESHOLD,
      };
      await this.dispose(session);
      // Cancellation can arrive while AudioContext.close is still pending.
      if (session.cancelled || session.generation !== this.generation) return;
      this.onDiagnostics?.(captured.length ? captureDiagnostics : null);
      void this.playCue("stop",session.sessionId,session.generation,this.cueEpoch);
      if (!captured.length) {
        await bridge.recordingFailed(
          "The microphone did not produce audio. Try another input.", session.sessionId,
        );
        return;
      }
      await bridge.submitRecording({
        sessionId: session.sessionId,
        wav: wav(resample(captured, sampleRate)),
        durationMs,
        captureDiagnostics,
      });
    } finally {
      await this.dispose(session);
    }
  }

  private dispose(session: CaptureSession): Promise<void> {
    if (session.disposal) return session.disposal;
    // Reserve disposal before clearing resources so repeated cancellation and
    // finalization await the same release instead of closing a context twice.
    session.disposal = Promise.resolve().then(async () => {
      session.finishFlush?.();
      clearTimeout(session.limitTimer);
      session.stopWatchingInput?.();
      session.liveLevel?.stop();
      if (session.worklet) session.worklet.port.onmessage = null;
      if (session.processor) session.processor.onaudioprocess = null;
      for (const node of [session.source, session.worklet, session.processor, session.sink]) {
        try {
          node?.disconnect();
        } catch { /* already disconnected */ }
      }
      session.stream?.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch { /* continue releasing the remaining tracks */ }
      });
      try {
        if (session.context && session.context.state !== "closed")
          await session.context.close();
      } catch {
        // Tracks and graph are already released even if the context was lost.
      } finally {
        session.context = null;
        session.stream = null;
        session.worklet = null;
        session.processor = null;
        session.source = null;
        session.sink = null;
        session.chunks = [];
        if (this.session === session) this.session = null;
        if (this.requestedSessionId === session.sessionId) this.requestedSessionId = null;
      }
    });
    return session.disposal;
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
