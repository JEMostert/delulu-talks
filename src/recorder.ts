import captureWorkletUrl from "./captureWorklet.js?url&no-inline";
import { bridge } from "./bridge";
import type { MicrophoneDevice, RecorderCommand } from "./types";

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
  private startedAt = 0;
  private stopping = false;
  private lastLevelAt = 0;
  private generation = 0;
  private sessionId: string | null = null;
  private requestedSessionId: string | null = null;
  private commands: Promise<void> = Promise.resolve();

  async cancel(): Promise<void> {
    await this.handle({ action: "cancel", inputDeviceId: "default" });
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
      this.requestedSessionId = sessionId;
    } else {
      sessionId ??= this.requestedSessionId ?? this.sessionId ?? undefined;
      if (
        sessionId &&
        sessionId !== this.requestedSessionId &&
        sessionId !== this.sessionId
      )
        return Promise.resolve();
      if (command.action === "cancel") {
        this.generation += 1;
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
    this.sessionId = sessionId;
    try {
      const exactDevice =
        deviceId && deviceId !== "default" ? { exact: deviceId } : undefined;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: exactDevice,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        this.finishSession(sessionId);
        return;
      }
      this.stream = stream;
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.source = this.context.createMediaStreamSource(this.stream);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.chunks = [];
      if (await this.connectWorklet(generation)) {
        this.source.connect(this.worklet!);
        this.worklet!.connect(this.sink);
      } else {
        this.processor = this.context.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (event) => {
          if (generation === this.generation)
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
      await bridge.recordingStarted(sessionId);
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
      this.worklet.port.onmessage = (
        event: MessageEvent<{ samples: Float32Array; rms: number }>,
      ) => {
        if (generation === this.generation && event.data?.samples)
          this.ingest(event.data.samples, event.data.rms);
      };
      return true;
    } catch {
      this.worklet = null;
      return false;
    }
  }

  private ingest(samples: Float32Array, rms?: number): void {
    this.chunks.push(new Float32Array(samples));
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
  }

  private async stop(submit: boolean, generation: number): Promise<void> {
    if (!this.stream || !this.context || this.stopping) return;
    const sessionId = this.sessionId!;
    this.stopping = true;
    try {
      const durationMs = Math.round(performance.now() - this.startedAt);
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
      await this.dispose();
      if (submit && generation === this.generation) {
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
  return [
    { deviceId: "default", label: "System default" },
    ...microphones
      .filter((device) => device.deviceId !== "default")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      })),
  ];
}
