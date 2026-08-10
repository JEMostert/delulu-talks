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

function resample(input: Float32Array, sourceRate: number, targetRate = 16_000): Float32Array {
  if (sourceRate === targetRate) return input;
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
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
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
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private stopping = false;

  async handle(command: RecorderCommand): Promise<void> {
    if (command.action === "start") await this.start(command.inputDeviceId);
    if (command.action === "stop") await this.stop(true);
    if (command.action === "cancel") await this.stop(false);
  }

  private async start(deviceId: string): Promise<void> {
    if (this.stream || this.stopping) return;
    try {
      const exactDevice = deviceId && deviceId !== "default" ? { exact: deviceId } : undefined;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: exactDevice,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.chunks = [];
      this.processor.onaudioprocess = (event) => this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.context.destination);
      this.startedAt = performance.now();
      await bridge.recordingStarted();
    } catch (error) {
      await this.dispose();
      await bridge.recordingFailed(`Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async stop(submit: boolean): Promise<void> {
    if (!this.stream || !this.context || this.stopping) return;
    this.stopping = true;
    const durationMs = Math.round(performance.now() - this.startedAt);
    const sampleRate = this.context.sampleRate;
    const captured = merge(this.chunks);
    await this.dispose();
    this.stopping = false;
    if (submit) await bridge.submitRecording({ wav: wav(resample(captured, sampleRate)), durationMs });
  }

  private async dispose(): Promise<void> {
    if (this.processor) this.processor.onaudioprocess = null;
    this.source?.disconnect();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
    this.stream = null;
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.chunks = [];
  }
}

export async function listMicrophones(requestPermission = false): Promise<MicrophoneDevice[]> {
  let temporary: MediaStream | null = null;
  if (requestPermission) {
    try { temporary = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* labels may remain private */ }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  temporary?.getTracks().forEach((track) => track.stop());
  const microphones = devices.filter((device) => device.kind === "audioinput");
  return [
    { deviceId: "default", label: "System default" },
    ...microphones.filter((device) => device.deviceId !== "default").map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ];
}
