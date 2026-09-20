/**
 * Tiny chiptune blips for the rabbit's big moments, made with WebAudio so there are no audio
 * assets. The context is created on the first user gesture, which is what browsers allow, and
 * every call before that is silently skipped.
 */

type Note = [frequency: number, seconds: number];

const CUES: Record<string, Note[]> = {
  aha: [[660, 0.07], [880, 0.07], [1320, 0.12]],
  hole_open: [[440, 0.05], [330, 0.05], [220, 0.09]],
  dive: [[520, 0.04], [390, 0.04], [260, 0.04], [170, 0.08]],
  hole_wait: [[330, 0.05], [392, 0.05]],
  celebrate: [[523, 0.07], [659, 0.07], [784, 0.07], [1047, 0.14]],
  land: [[150, 0.06], [110, 0.08]],
  panic: [[880, 0.05], [740, 0.05], [880, 0.05], [740, 0.05]],
  wave: [[587, 0.06], [784, 0.1]],
};

let ctx: AudioContext | null = null;
let armed = false;
let enabled = true;

/** Call once from anywhere the user can click; the first gesture unlocks audio. */
export function armSounds(): void {
  if (armed) return;
  armed = true;
  const unlock = () => {
    try {
      ctx = ctx ?? new AudioContext();
      void ctx.resume();
    } catch {
      ctx = null;
    }
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
}

/** Plays the cue for a state name, if there is one. Square waves, quiet, a few hundredths of a second each. */
export function playCue(state: string): void {
  const notes = CUES[state];
  if (!notes || !enabled || !ctx || ctx.state !== "running") return;
  let t = ctx.currentTime;
  for (const [freq, secs] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + secs);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + secs + 0.01);
    t += secs;
  }
}

/**
 * One syllable of rabbit talk: a short triangle blip whose pitch comes from the letter, so the
 * same word always sounds the same. Quiet and quick, like game dialogue.
 */
export function voiceBlip(charCode: number): void {
  if (!enabled || !ctx || ctx.state !== "running") return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(560 + ((charCode * 37) % 320), t);
  osc.frequency.exponentialRampToValueAtTime(420 + ((charCode * 53) % 240), t + 0.05);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.035, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

