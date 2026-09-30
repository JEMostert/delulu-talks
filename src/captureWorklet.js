class DeluluCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paused = false;
    this.chunks = [];
    this.samples = 0;
    this.sumSquares = 0;
    this.port.onmessage = (event) => {
      if (event.data?.action === "pause" || event.data?.action === "resume") {
        if (event.data.action === "pause") this.flush();
        this.paused = event.data.action === "pause";
        this.port.postMessage({ pauseChanged: this.paused });
      }
      if (event.data === "flush") {
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  flush() {
    if (!this.samples) return;
    const merged = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.port.postMessage(
      { samples: merged, rms: Math.sqrt(this.sumSquares / this.samples) },
      [merged.buffer],
    );
    this.chunks = [];
    this.samples = 0;
    this.sumSquares = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && !this.paused) {
      this.chunks.push(new Float32Array(channel));
      this.samples += channel.length;
      for (let index = 0; index < channel.length; index += 1)
        this.sumSquares += channel[index] * channel[index];
      if (this.samples >= 2048) this.flush();
    }
    return true;
  }
}
registerProcessor("delulu-capture", DeluluCaptureProcessor);
