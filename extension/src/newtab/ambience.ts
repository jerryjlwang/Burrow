// Quiet ambience from WebAudio only, no files: filtered noise for wind with an occasional two note bird
// by day, short high pulses for crickets at night. Starts on the first interaction, and the speaker sign
// on the page turns it off and on.

export interface Ambience {
  /** Begin, once a context exists. Safe to call more than once. */
  start(ctx: AudioContext): void;
  setEnabled(on: boolean): void;
  setMode(mode: "day" | "night"): void;
  stop(): void;
}

export function createAmbience(): Ambience {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let wind: GainNode | null = null;
  let enabled = true;
  let mode: "day" | "night" = "day";
  let gustTimer = 0;
  let birdTimer = 0;
  let cricketTimer = 0;

  const rand = (a: number, b: number): number => a + Math.random() * (b - a);

  const note = (freq: number, ms: number, type: OscillatorType, gain: number, delay: number): void => {
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = 0;
    osc.connect(g).connect(master);
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.setValueAtTime(gain, t + ms / 1000 - 0.008);
    g.gain.linearRampToValueAtTime(0, t + ms / 1000);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  };

  const gust = (): void => {
    if (!ctx || !wind) return;
    wind.gain.setTargetAtTime(rand(0.012, 0.045), ctx.currentTime, 0.9);
    gustTimer = window.setTimeout(gust, rand(1500, 3500));
  };
  const bird = (): void => {
    if (mode === "day") {
      const base = rand(1700, 2100);
      note(base, 70, "triangle", 0.03, 0);
      note(base * 1.3, 90, "triangle", 0.024, 0.11);
    }
    birdTimer = window.setTimeout(bird, rand(7000, 18000));
  };
  const cricket = (): void => {
    if (mode === "night") {
      for (let i = 0; i < 3; i++) note(rand(4100, 4500), 18, "sine", 0.02, i * 0.06);
    }
    cricketTimer = window.setTimeout(cricket, mode === "night" ? rand(700, 1300) : 2000);
  };

  return {
    start(c) {
      if (ctx) return;
      ctx = c;
      master = ctx.createGain();
      master.gain.value = enabled ? 0.7 : 0;
      master.connect(ctx.destination);
      // Two seconds of noise, looped, through a low pass: the wind bed.
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 360;
      low.Q.value = 0.4;
      wind = ctx.createGain();
      wind.gain.value = 0.02;
      noise.connect(low).connect(wind).connect(master);
      noise.start();
      gust();
      birdTimer = window.setTimeout(bird, rand(2500, 6000));
      cricketTimer = window.setTimeout(cricket, 1200);
    },
    setEnabled(on) {
      enabled = on;
      if (ctx && master) master.gain.setTargetAtTime(on ? 0.7 : 0, ctx.currentTime, 0.15);
    },
    setMode(m) {
      mode = m;
    },
    stop() {
      window.clearTimeout(gustTimer);
      window.clearTimeout(birdTimer);
      window.clearTimeout(cricketTimer);
      if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
    },
  };
}
