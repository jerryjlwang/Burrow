import { store } from "../../content/store";

/**
 * The short cues of the watching along pieces (video.ts): one per piece at most, a few hundredths of
 * a second of square wave, never loud. Gated like the tunnel whoosh: only with sounds on, and only
 * once the page has had a gesture, since a context made before that stays suspended. Silent otherwise.
 */
export type VideoCue = "pause" | "play" | "bang" | "tick";

type Note = [frequency: number, seconds: number, at: number];

const CUES: Record<VideoCue, Note[]> = {
  // The tap lands and the picture stops: two notes down.
  pause: [[520, 0.05, 0], [330, 0.09, 0.05]],
  // Up and away as it resumes.
  play: [[392, 0.05, 0], [587, 0.05, 0.05], [784, 0.09, 0.1]],
  // The "!" over his head.
  bang: [[988, 0.04, 0], [1319, 0.08, 0.04]],
  // One tick per turn of the watch hand (video.ts spins it three times, 0.36 s a turn).
  tick: [[2400, 0.015, 0], [2400, 0.015, 0.36], [2400, 0.015, 0.72]],
};
const GAIN = 0.04;

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (!store.getState().settings.ttsEnabled) return null;
  try {
    ctx = ctx ?? new AudioContext();
    if (ctx.state !== "running") void ctx.resume();
  } catch {
    ctx = null;
  }
  return ctx && ctx.state === "running" ? ctx : null;
}

export function videoCue(name: VideoCue): void {
  try {
    const ac = audio();
    if (!ac) return;
    const t0 = ac.currentTime;
    for (const [freq, secs, at] of CUES[name]) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, t0 + at);
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(GAIN, t0 + at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + secs);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + secs + 0.01);
    }
  } catch {
    // A cue that cannot play is not worth a word.
  }
}
