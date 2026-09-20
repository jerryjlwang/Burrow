/**
 * Loopback check of the voice pipeline through a running Pip server:
 *   1. Flux TTS: speak a sentence, measure time-to-first-audio, collect the 24 kHz PCM.
 *   2. Flux STT: downsample to 16 kHz, stream it back as a microphone would, print the transcript.
 * Usage: PIP_SERVER=http://localhost:8787 npx tsx scripts/voice-check.ts
 */
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const base = (process.env.PIP_SERVER ?? "http://localhost:8787").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const SENTENCE = process.argv.slice(2).join(" ") || "Where is the sign in button?";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tts(): Promise<Buffer> {
  const ws = new WebSocket(`${wsBase}/ws/tts`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const chunks: Buffer[] = [];
  const t0 = Date.now();
  let firstAudioAt = 0;
  const done = new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("TTS timed out")), 25_000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!firstAudioAt) firstAudioAt = Date.now();
        chunks.push(Buffer.from(data as ArrayBuffer));
        return;
      }
      const m = JSON.parse(data.toString());
      if (m.type === "done") {
        clearTimeout(timer);
        res();
      } else if (m.type === "error") {
        clearTimeout(timer);
        rej(new Error(`TTS error: ${m.message}`));
      }
    });
  });
  ws.send(JSON.stringify({ type: "speak", id: "vc1", text: SENTENCE }));
  await done;
  ws.close();
  const pcm = Buffer.concat(chunks);
  console.log(`TTS  ✓ first audio after ${firstAudioAt - t0}ms · ${(pcm.length / 2 / 24000).toFixed(2)}s of audio · complete in ${Date.now() - t0}ms`);
  return pcm;
}

function downsample24to16(pcm24: Buffer): Buffer {
  const inSamples = pcm24.length / 2;
  const outSamples = Math.floor((inSamples * 2) / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = i * 1.5;
    const i0 = Math.floor(pos);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = pos - i0;
    const s = pcm24.readInt16LE(i0 * 2) * (1 - frac) + pcm24.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

async function stt(pcm16: Buffer): Promise<void> {
  const ws = new WebSocket(`${wsBase}/ws/stt`);
  ws.binaryType = "arraybuffer";
  const t0 = Date.now();
  let readyAt = 0;
  let final = "";
  let lastInterim = "";
  const finished = new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`STT timed out (last interim: "${lastInterim}")`)), 30_000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString());
      if (m.type === "ready") readyAt = Date.now();
      else if (m.type === "transcript") {
        if (m.final) {
          final = m.text;
          clearTimeout(timer);
          res();
        } else if (m.text) lastInterim = m.text;
      } else if (m.type === "error") {
        clearTimeout(timer);
        rej(new Error(`STT error: ${m.message}`));
      }
    });
    ws.on("error", rej);
  });
  await new Promise<void>((res) => ws.once("open", () => res()));
  while (!readyAt) await wait(20);
  console.log(`STT  ✓ session ready in ${readyAt - t0}ms · streaming ${(pcm16.length / 2 / 16000).toFixed(2)}s of audio`);
  const chunk = 16000 * 2 * 0.04; // 40 ms
  const withSilence = Buffer.concat([pcm16, Buffer.alloc(16000 * 2 * 2)]); // 2 s trailing silence
  const streamStart = Date.now();
  for (let off = 0; off < withSilence.length; off += chunk) {
    ws.send(withSilence.subarray(off, Math.min(withSilence.length, off + chunk)));
    await wait(10);
  }
  const speechEnd = streamStart + (pcm16.length / 2 / 16000) * 1000 * (10 / 40);
  await finished;
  console.log(`STT  ✓ transcript: "${final}" (end of turn ${Math.max(0, Date.now() - speechEnd)}ms after speech ended, sim time)`);
  ws.close();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  console.log(norm(final) === norm(SENTENCE) ? "ROUNDTRIP ✓ transcript matches the spoken sentence" : `ROUNDTRIP ~ transcript differs from "${SENTENCE}"`);
}

const health = await fetch(`${base}/health`).then((r) => r.json());
console.log(`server: llm=${health.llm} deepgram=${health.deepgram} tts=${health.tts.model} stt=${health.stt}`);
const pcm24 = await tts();
const wavPath = process.env.VOICE_CHECK_WAV;
if (wavPath) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm24.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm24.length, 40);
  writeFileSync(wavPath, Buffer.concat([header, pcm24]));
  console.log(`wav written to ${wavPath}`);
}
await stt(downsample24to16(pcm24));
