// Tiny sounds for the page: one square wave per typed character, and a distinct blip for each thing the
// kid clicks. The context is created on the first keydown or pointer press so the browser treats it as
// user initiated; before that everything is silent.

let ctx: AudioContext | null = null;

export function armBlip(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
}

export function audioContext(): AudioContext | null {
  return ctx;
}

/** One note: `ms` long, starting `delay` seconds from now. */
export function tone(freq: number, ms: number, type: OscillatorType = "square", gain = 0.03, delay = 0): void {
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = 0;
    osc.connect(g).connect(ctx.destination);
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(gain, t);
    g.gain.setValueAtTime(gain, t + ms / 1000 - 0.005);
    g.gain.setValueAtTime(0, t + ms / 1000);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.01);
  } catch {
    /* no sound is fine */
  }
}

/** The typing blip: 40 ms, quiet, a little higher every few letters. */
export function blip(step: number): void {
  tone(620 + (step % 5) * 55, 40, "square", 0.025);
}

/** Each reaction has its own voice. */
export function blipFor(kind: string): void {
  switch (kind) {
    case "bloom":
      tone(880, 50, "square", 0.022);
      tone(1320, 60, "square", 0.018, 0.06);
      return;
    case "bounce":
      tone(440, 45, "square", 0.028);
      tone(660, 45, "square", 0.028, 0.13);
      return;
    case "wiggle":
      tone(300, 30, "triangle", 0.035);
      return;
    case "rain":
      tone(240, 120, "triangle", 0.03);
      tone(200, 120, "triangle", 0.025, 0.13);
      return;
    case "chirp":
      tone(1800, 60, "triangle", 0.03);
      tone(2400, 60, "triangle", 0.025, 0.08);
      return;
    case "puff":
      tone(150, 100, "sine", 0.05);
      return;
    case "creak":
      tone(520, 70, "sawtooth", 0.014);
      tone(380, 100, "sawtooth", 0.014, 0.09);
      return;
    case "heart":
      tone(990, 60, "sine", 0.03);
      tone(1320, 90, "sine", 0.03, 0.08);
      return;
    case "munch":
      tone(200, 40, "square", 0.03);
      tone(150, 40, "square", 0.03, 0.1);
      tone(200, 40, "square", 0.03, 0.2);
      return;
    case "pick":
      tone(520, 35, "square", 0.025);
      return;
    case "splash":
      tone(300, 40, "triangle", 0.03);
      tone(180, 80, "triangle", 0.025, 0.05);
      return;
    case "honk":
      tone(330, 90, "sawtooth", 0.014);
      tone(290, 90, "sawtooth", 0.014, 0.1);
      return;
    case "rattle":
      tone(1400, 25, "square", 0.02);
      tone(1500, 25, "square", 0.02, 0.06);
      tone(1400, 25, "square", 0.02, 0.12);
      return;
    case "paint":
      tone(700, 60, "sine", 0.03);
      tone(560, 90, "sine", 0.025, 0.07);
      return;
    case "salute":
      tone(880, 50, "square", 0.02);
      tone(1175, 90, "square", 0.02, 0.06);
      return;
    case "baa":
      tone(392, 60, "sawtooth", 0.012);
      tone(370, 110, "sawtooth", 0.012, 0.07);
      return;
    default:
      return;
  }
}
