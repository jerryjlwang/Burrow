import type { CharacterManifest, JumpStep, OverlayName, StateDef } from "./manifest";

/** What is on the canvas right now. */
interface Shown {
  name: string;
  def: StateDef;
  frame: number;
  acc: number;
  reverse: boolean;
  /** Wrap at the ends instead of finishing. */
  loop: boolean;
  /** A non-looping play reached its last frame. */
  ended: boolean;
}

type Mode = "normal" | "override" | "sequence";

export interface PlayerOptions {
  random?: () => number;
  warn?: (message: string) => void;
}

const BLINK_GAP: [number, number] = [2, 5];
const FALLBACK = "idle";

/**
 * Manifest-driven sprite player. Owns timing and the state machine; knows nothing
 * about React or the DOM beyond drawing into a 2d context on request.
 *
 * Vocabulary:
 * - target: the state the app asked for (after the transition chain settles).
 * - shown: the strip actually on screen (a transition, a variant, the target, or a sequence step).
 * - chain: transition states still to play before the target shows.
 * - pending: the latest request made while a transition or one-shot was busy.
 */
export class SpritePlayer {
  readonly manifest: CharacterManifest;
  /** Set whenever the picture changes; the owner clears it after drawing. */
  dirty = true;

  private images: Record<string, HTMLImageElement> | null;
  private readonly random: () => number;
  private readonly warn: (message: string) => void;
  private readonly warned = new Set<string>();

  private shown: Shown;
  private target = FALLBACK;
  private chain: string[] = [];
  private pending: string | null = null;
  private mode: Mode = "normal";
  private hidden = false;
  private stepDone: (() => void) | null = null;
  private sequenceTail: Promise<void> = Promise.resolve();
  private sequenceQueued = 0;

  private speaking = false;
  private mouthFrame = 0;
  private reducedMotion = false;
  private blinkFrame = -1;
  private blinkAcc = 0;
  private blinkTimer: number;
  private variantTimer = -1;

  constructor(manifest: CharacterManifest, images: Record<string, HTMLImageElement> | null = null, opts: PlayerOptions = {}) {
    if (!manifest.states?.[FALLBACK]) throw new Error("Character manifest needs an idle state");
    this.manifest = manifest;
    this.images = images;
    this.random = opts.random ?? Math.random;
    this.warn = opts.warn ?? ((m) => console.warn(`[pet] ${m}`));
    this.blinkTimer = this.gap(BLINK_GAP);
    this.shown = this.make(FALLBACK, false, true);
    this.scheduleVariant();
  }

  /* ---------- public state ---------- */

  /** Name of the strip on screen. */
  get current(): string {
    return this.shown.name;
  }
  get frame(): number {
    return this.shown.frame;
  }
  /** The state the app asked for. */
  get requested(): string {
    return this.target;
  }
  get inSequence(): boolean {
    return this.mode === "sequence";
  }
  get isHidden(): boolean {
    return this.hidden;
  }

  /** Whether `name` is a state in the manifest. */
  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.manifest.states, name);
  }

  /** Validates a state name; unknown names fall back to idle with one warning each. */
  resolve(name: string): string {
    if (this.has(name)) return name;
    if (!this.warned.has(name)) {
      this.warned.add(name);
      this.warn(`Unknown state "${name}", using ${FALLBACK}`);
    }
    return FALLBACK;
  }

  /* ---------- requests ---------- */

  /** Ask for a state. Transitions and one-shots finish first; the latest request wins. */
  setState(name: string): void {
    const next = this.resolve(name);
    if (this.mode !== "normal") {
      this.target = next;
      this.pending = null;
      return;
    }
    if (this.busy()) {
      this.pending = next;
      return;
    }
    if (next === this.target) return;
    this.transitionTo(next);
  }

  /** Take over the picture immediately (dragging). Pass null to resume the requested state. */
  override(name: string | null): void {
    if (this.mode === "sequence") return;
    if (name === null) {
      if (this.mode !== "override") return;
      this.mode = "normal";
      this.resume();
      return;
    }
    this.mode = "override";
    this.chain = [];
    this.pending = null;
    const resolved = this.resolve(name);
    this.show(resolved, false, this.manifest.states[resolved].loop);
  }

  /**
   * Plays manifest steps in order and resolves when they are done. A step with `loop: true`
   * plays until `until` resolves. Requests made meanwhile apply after the last step.
   * Sequences queue behind each other.
   */
  runSequence(steps: JumpStep[], until?: Promise<unknown>): Promise<void> {
    const run = async () => {
      try {
        this.mode = "sequence";
        this.chain = [];
        this.pending = null;
        this.hidden = false;
        this.dirty = true;
        const last = steps.length - 1;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const name = this.resolve(step.state);
          const def = this.manifest.states[name];
          if (step.loop) {
            this.show(name, !!step.reverse, true);
            await (until ?? Promise.resolve()).catch(() => undefined);
            continue;
          }
          // A looping state as the final step is the resting pose; `resume` shows the real target.
          if (def.loop && i === last) break;
          this.show(name, !!step.reverse, false);
          await new Promise<void>((done) => {
            this.stepDone = done;
          });
        }
        this.mode = "normal";
        this.resume();
      } finally {
        this.sequenceQueued--;
      }
    };
    // Start now when idle so the first step shows this frame; otherwise wait for the running one.
    const first = this.sequenceQueued === 0;
    this.sequenceQueued++;
    const p = first ? run() : this.sequenceTail.then(run, run);
    this.sequenceTail = p.catch(() => undefined);
    return p;
  }

  /** Draw nothing until the next sequence or `setHidden(false)`. */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.dirty = true;
  }

  setSpeaking(speaking: boolean, level: number): void {
    const frame = level < 0.15 ? 0 : level < 0.5 ? 1 : 2;
    if (speaking === this.speaking && frame === this.mouthFrame) return;
    this.speaking = speaking;
    this.mouthFrame = frame;
    if (this.allows("mouth")) this.dirty = true;
  }

  setReducedMotion(on: boolean): void {
    if (this.reducedMotion === on) return;
    this.reducedMotion = on;
    if (on && this.blinkFrame >= 0) {
      this.blinkFrame = -1;
      this.blinkTimer = this.gap(BLINK_GAP);
      this.dirty = true;
    }
  }

  setImages(images: Record<string, HTMLImageElement>): void {
    this.images = images;
    this.dirty = true;
  }

  /* ---------- time ---------- */

  /** Advance by `dt` seconds. */
  tick(dt: number): void {
    if (this.hidden) return;
    const s = this.shown;
    if (!s.ended) {
      const step = 1 / Math.max(s.def.fps, 1);
      s.acc += dt;
      while (s.acc >= step) {
        s.acc -= step;
        let nf = s.frame + (s.reverse ? -1 : 1);
        if (nf < 0 || nf >= s.def.frames) {
          if (s.loop) {
            nf = (nf + s.def.frames) % s.def.frames;
          } else {
            this.onEnded();
            break;
          }
        }
        if (nf !== s.frame) this.dirty = true;
        s.frame = nf;
      }
    }
    this.tickBlink(dt);
    this.tickVariant(dt);
  }

  /** Paint the current frame and overlays at a whole-number scale. */
  draw(ctx: CanvasRenderingContext2D, scale: number): void {
    const [cw, ch] = this.manifest.cell;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (this.hidden || !this.images) return;
    const s = this.shown;
    const img = this.images[s.name];
    if (!img) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, s.frame * cw, 0, cw, ch, 0, 0, cw * scale, ch * scale);
    const dy = (s.def.head_dy?.[s.frame] ?? 0) * scale;
    const put = (name: string, frame: number) => {
      const strip = this.images?.[name];
      if (strip) ctx.drawImage(strip, frame * cw, 0, cw, ch, 0, dy, cw * scale, ch * scale);
    };
    if (this.speaking && this.allows("mouth")) put("overlay_mouth", this.mouthFrame);
    if (this.blinkFrame >= 0 && this.allows("blink")) put("overlay_blink", this.blinkFrame);
  }

  /* ---------- internals ---------- */

  private busy(): boolean {
    if (this.chain.length) return true;
    if (this.shown.name !== this.target) return true;
    if (this.shown.loop) return false;
    return !this.shown.ended;
  }

  private transitionTo(next: string): void {
    const from = this.manifest.states[this.target];
    const to = this.manifest.states[next];
    this.chain = [];
    if (this.shown.name === this.target && from.exit && this.has(from.exit)) this.chain.push(from.exit);
    if (to.enter && this.has(to.enter)) this.chain.push(to.enter);
    this.target = next;
    this.advance();
  }

  /** Show the next chain step, or the target when the chain is empty. */
  private advance(): void {
    const step = this.chain.shift();
    if (step) {
      this.show(step, false, false);
      return;
    }
    const def = this.manifest.states[this.target];
    this.show(this.target, false, def.loop);
    this.flushPending();
  }

  /** After an override or a sequence: replay the target's enter (if any), then the target. */
  private resume(): void {
    const def = this.manifest.states[this.target];
    this.chain = def.enter && this.has(def.enter) ? [def.enter] : [];
    this.advance();
  }

  private flushPending(): void {
    const p = this.pending;
    this.pending = null;
    if (p !== null && p !== this.target) this.setState(p);
  }

  private onEnded(): void {
    const s = this.shown;
    s.ended = true;
    this.dirty = true;
    if (this.mode === "sequence") {
      const done = this.stepDone;
      this.stepDone = null;
      done?.();
      return;
    }
    if (this.mode === "override") return;
    if (this.chain.length) {
      this.advance();
      return;
    }
    if (s.name !== this.target) {
      // A variant finished; back to the target (idle).
      this.advance();
      return;
    }
    if (s.def.hold) {
      this.flushPending();
      return;
    }
    // A one-shot target without hold falls back to idle.
    this.target = FALLBACK;
    this.show(FALLBACK, false, true);
    this.flushPending();
  }

  private make(name: string, reverse: boolean, loop: boolean): Shown {
    const def = this.manifest.states[name];
    return { name, def, frame: reverse ? Math.max(0, def.frames - 1) : 0, acc: 0, reverse, loop, ended: false };
  }

  private show(name: string, reverse: boolean, loop: boolean): void {
    this.shown = this.make(name, reverse, loop);
    this.dirty = true;
    if (name === FALLBACK) this.scheduleVariant();
  }

  private allows(overlay: OverlayName): boolean {
    return !!this.shown.def.overlays?.includes(overlay);
  }

  private gap([min, max]: [number, number]): number {
    return min + this.random() * Math.max(0, max - min);
  }

  private tickBlink(dt: number): void {
    if (this.reducedMotion) return;
    const blinkDef = this.manifest.states.overlay_blink;
    if (!blinkDef) return;
    if (this.blinkFrame < 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer > 0) return;
      this.blinkTimer = this.gap(BLINK_GAP);
      if (!this.allows("blink")) return;
      this.blinkFrame = 0;
      this.blinkAcc = 0;
      this.dirty = true;
      return;
    }
    const step = 1 / Math.max(blinkDef.fps, 1);
    this.blinkAcc += dt;
    while (this.blinkAcc >= step) {
      this.blinkAcc -= step;
      this.blinkFrame++;
      this.dirty = true;
      if (this.blinkFrame >= blinkDef.frames) {
        this.blinkFrame = -1;
        break;
      }
    }
  }

  private scheduleVariant(): void {
    const gap = this.manifest.idle_variant_gap;
    this.variantTimer = gap ? this.gap(gap) : -1;
  }

  private tickVariant(dt: number): void {
    if (this.reducedMotion || this.mode !== "normal" || this.variantTimer < 0) return;
    if (this.shown.name !== FALLBACK || this.target !== FALLBACK || this.chain.length) return;
    const variants = (this.manifest.states[FALLBACK].variants ?? []).filter((v) => this.has(v.state) && v.weight > 0);
    if (!variants.length) return;
    this.variantTimer -= dt;
    if (this.variantTimer > 0) return;
    const total = variants.reduce((sum, v) => sum + v.weight, 0);
    let pick = this.random() * total;
    let chosen = variants[variants.length - 1].state;
    for (const v of variants) {
      pick -= v.weight;
      if (pick < 0) {
        chosen = v.state;
        break;
      }
    }
    this.show(chosen, false, false);
    this.variantTimer = -1;
  }
}
