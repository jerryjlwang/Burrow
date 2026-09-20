/**
 * The sound of the trip between screens. Nothing here knows about pages or the store: it draws on
 * whatever audio context it is given, so the same code renders offline for a check and plays live
 * from `tunnel.ts` once the page has had its click.
 *
 * The shape: a boom as he goes under, a low rumble that travels and swells while he is underground,
 * a riser that climbs as he nears the surface, and a bright burst the moment he pops out on the
 * other side. `emerge(inMs)` fixes that moment; `stop()` fades everything out early.
 */
export interface Journey {
  /** He pops out this many ms from now: the swell climbs to that moment and the burst lands on it. */
  emerge: (inMs: number) => void;
  /** Fade out now (a jump that never completed). */
  stop: () => void;
}

/** Brown-ish noise: white noise leaked through a one pole low pass, loud enough to matter. */
function rumbleBuffer(ac: BaseAudioContext, secs: number): AudioBuffer {
  const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * secs), ac.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

export function journeyOn(ac: BaseAudioContext, dest: AudioNode, t0 = ac.currentTime): Journey {
  const master = ac.createGain();
  master.gain.value = 0.9;
  master.connect(dest);

  // The boom: a sine dropping from 70 Hz to 28 Hz with a fast attack, gone inside a second.
  const boom = ac.createOscillator();
  boom.type = "sine";
  boom.frequency.setValueAtTime(70, t0);
  boom.frequency.exponentialRampToValueAtTime(28, t0 + 0.5);
  const boomGain = ac.createGain();
  boomGain.gain.setValueAtTime(0.0001, t0);
  boomGain.gain.exponentialRampToValueAtTime(0.6, t0 + 0.04);
  boomGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
  boom.connect(boomGain).connect(master);
  boom.start(t0);
  boom.stop(t0 + 1);

  // The rumble: looping noise through a low resonant filter that wobbles, swelling in over the first beat.
  const buffer = rumbleBuffer(ac, 2);
  const noise = ac.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const low = ac.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.setValueAtTime(160, t0);
  low.Q.value = 6;
  const wobble = ac.createOscillator();
  wobble.type = "sine";
  wobble.frequency.value = 2.3;
  const wobbleDepth = ac.createGain();
  wobbleDepth.gain.value = 40;
  wobble.connect(wobbleDepth).connect(low.frequency);
  wobble.start(t0);
  const rumbleGain = ac.createGain();
  rumbleGain.gain.setValueAtTime(0.0001, t0);
  rumbleGain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.6);
  noise.connect(low).connect(rumbleGain).connect(master);
  noise.start(t0);

  // The body under it: a sawtooth at 38 Hz, low passed, so the rumble has weight on small speakers too.
  const sub = ac.createOscillator();
  sub.type = "sawtooth";
  sub.frequency.value = 38;
  const subLow = ac.createBiquadFilter();
  subLow.type = "lowpass";
  subLow.frequency.value = 90;
  const subGain = ac.createGain();
  subGain.gain.setValueAtTime(0.0001, t0);
  subGain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.8);
  sub.connect(subLow).connect(subGain).connect(master);
  sub.start(t0);

  let done = false;
  const stopSources = (at: number) => {
    noise.stop(at);
    sub.stop(at);
    wobble.stop(at);
  };

  const emerge = (inMs: number) => {
    if (done) return;
    done = true;
    const te = ac.currentTime + Math.max(0, inMs) / 1000;
    // The last stretch climbs: the filter opens and the rumble swells toward the surface, then both
    // drop away right after the burst. Straight automation, nothing cancelled, so the climb is heard.
    const climb = Math.max(0.05, Math.min(1.6, (inMs / 1000) * 0.6));
    low.frequency.setValueAtTime(160, te - climb);
    low.frequency.exponentialRampToValueAtTime(1400, te);
    rumbleGain.gain.setValueAtTime(0.35, te - climb);
    rumbleGain.gain.linearRampToValueAtTime(0.7, te);
    rumbleGain.gain.exponentialRampToValueAtTime(0.0001, te + 0.3);
    subGain.gain.setValueAtTime(0.25, te);
    subGain.gain.exponentialRampToValueAtTime(0.0001, te + 0.3);
    stopSources(te + 0.35);
    // A riser: a triangle climbing two octaves into the burst, fading in straight so it is heard early.
    const riser = ac.createOscillator();
    riser.type = "triangle";
    riser.frequency.setValueAtTime(110, te - climb);
    riser.frequency.exponentialRampToValueAtTime(440, te);
    const riserGain = ac.createGain();
    riserGain.gain.setValueAtTime(0, te - climb);
    riserGain.gain.linearRampToValueAtTime(0.16, te - 0.05);
    riserGain.gain.linearRampToValueAtTime(0, te + 0.05);
    riser.connect(riserGain).connect(master);
    riser.start(te - climb);
    riser.stop(te + 0.1);
    // The burst: a thump as he breaks the surface, a quick square arpeggio, and a sparkle of high noise.
    const thump = ac.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(90, te);
    thump.frequency.exponentialRampToValueAtTime(40, te + 0.25);
    const thumpGain = ac.createGain();
    thumpGain.gain.setValueAtTime(0.0001, te);
    thumpGain.gain.exponentialRampToValueAtTime(0.5, te + 0.02);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, te + 0.35);
    thump.connect(thumpGain).connect(master);
    thump.start(te);
    thump.stop(te + 0.4);
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = "square";
      o.frequency.value = f;
      const g = ac.createGain();
      const ts = te + i * 0.07;
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.exponentialRampToValueAtTime(0.16, ts + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.24);
      o.connect(g).connect(master);
      o.start(ts);
      o.stop(ts + 0.26);
    });
    const sparkle = ac.createBufferSource();
    sparkle.buffer = buffer;
    const high = ac.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 3800;
    const sparkleGain = ac.createGain();
    sparkleGain.gain.setValueAtTime(0.0001, te);
    sparkleGain.gain.exponentialRampToValueAtTime(0.14, te + 0.02);
    sparkleGain.gain.exponentialRampToValueAtTime(0.0001, te + 0.5);
    sparkle.connect(high).connect(sparkleGain).connect(master);
    sparkle.start(te);
    sparkle.stop(te + 0.55);
  };

  /** A jump that never completed: fade everything out now. */
  const stop = () => {
    if (done) return;
    done = true;
    const at = ac.currentTime;
    for (const g of [rumbleGain, subGain]) {
      g.gain.cancelScheduledValues(at);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    }
    stopSources(at + 0.3);
  };

  return { emerge, stop };
}
