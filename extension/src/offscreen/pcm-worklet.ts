/* AudioWorklet: converts mic float32 audio to 16-bit PCM chunks (~40ms) and reports input level. */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private pending: Int16Array;
  private filled = 0;
  private levelAcc = 0;
  private levelCount = 0;
  private lastLevelAt = 0;
  private readonly chunkSamples: number;

  constructor() {
    super();
    this.chunkSamples = Math.round((sampleRate || 16000) * 0.04);
    this.pending = new Int16Array(this.chunkSamples);
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let sum = 0;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      sum += s * s;
      this.pending[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled >= this.chunkSamples) {
        const buffer = this.pending.buffer.slice(0);
        this.port.postMessage({ type: "chunk", buffer }, [buffer]);
        this.pending = new Int16Array(this.chunkSamples);
        this.filled = 0;
      }
    }
    this.levelAcc += sum;
    this.levelCount += channel.length;
    const now = (globalThis as unknown as { currentTime: number }).currentTime ?? 0;
    if (now - this.lastLevelAt > 0.08 && this.levelCount > 0) {
      const rms = Math.sqrt(this.levelAcc / this.levelCount);
      this.port.postMessage({ type: "level", level: Math.min(1, rms * 6) });
      this.levelAcc = 0;
      this.levelCount = 0;
      this.lastLevelAt = now;
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
