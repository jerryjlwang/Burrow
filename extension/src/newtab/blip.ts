// A tiny typing blip: one square wave, 40 ms, quiet. The context is created on the first keydown so
// the browser treats it as user initiated.

let ctx: AudioContext | null = null;

export function armBlip(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
}

export function blip(step: number): void {
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 620 + (step % 5) * 55;
    gain.gain.value = 0.025;
    osc.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime;
    osc.start(t);
    gain.gain.setValueAtTime(0.025, t + 0.035);
    gain.gain.setValueAtTime(0, t + 0.04);
    osc.stop(t + 0.045);
  } catch {
    /* no sound is fine */
  }
}
