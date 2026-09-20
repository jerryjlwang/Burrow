import { describe, expect, it } from "vitest";
import { SpritePlayer } from "../player";
import type { CharacterManifest } from "../manifest";

/** A small manifest with the shapes the contract describes, including transitions and variants. */
function manifest(): CharacterManifest {
  return {
    character: "test",
    cell: [64, 58],
    body: [19, 2, 50, 55],
    idle_variant_gap: [4, 9],
    jump_sequence: {
      sending: [{ state: "hole_open" }, { state: "dive" }, { state: "hole_only", reverse: true }],
      receiving: [{ state: "hole_only" }, { state: "hole_wait", loop: true }, { state: "dive", reverse: true }, { state: "hole_open", reverse: true }, { state: "idle" }],
    },
    states: {
      idle: { file: "i.png", frames: 4, fps: 4, loop: true, head_dy: [0, 0, 1, 1], overlays: ["blink", "mouth"], variants: [{ state: "wave", weight: 1 }] },
      listening: { file: "l.png", frames: 3, fps: 10, loop: false, hold: true, overlays: ["blink"], enter: "to_listening", exit: "from_listening" },
      to_listening: { file: "tl.png", frames: 2, fps: 10, loop: false },
      from_listening: { file: "fl.png", frames: 2, fps: 10, loop: false },
      thinking: { file: "t.png", frames: 4, fps: 4, loop: true, exit: "aha" },
      aha: { file: "a.png", frames: 4, fps: 10, loop: false },
      celebrate: { file: "c.png", frames: 6, fps: 10, loop: false },
      wave: { file: "w.png", frames: 4, fps: 10, loop: false },
      dragged: { file: "d.png", frames: 2, fps: 4, loop: true },
      hole_only: { file: "h.png", frames: 3, fps: 10, loop: false },
      hole_open: { file: "ho.png", frames: 3, fps: 10, loop: false },
      dive: { file: "dv.png", frames: 7, fps: 10, loop: false },
      hole_wait: { file: "hw.png", frames: 4, fps: 10, loop: true },
      overlay_blink: { file: "ob.png", frames: 3, fps: 12, loop: false },
      overlay_mouth: { file: "om.png", frames: 4, fps: 0, loop: false },
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Advance in 10 ms steps so every frame boundary is crossed. */
function run(p: SpritePlayer, seconds: number): void {
  const steps = Math.round(seconds / 0.01);
  for (let i = 0; i < steps; i++) p.tick(0.01);
}

const noVariants = { random: () => 0.999 };

describe("SpritePlayer", () => {
  it("starts on idle and loops", () => {
    const p = new SpritePlayer(manifest(), null, noVariants);
    expect(p.current).toBe("idle");
    run(p, 1.05);
    expect(p.current).toBe("idle");
    expect(p.frame).toBe(0);
  });

  it("plays exit then enter then the state, and holds a hold state", () => {
    const p = new SpritePlayer(manifest(), null, noVariants);
    p.setState("thinking");
    expect(p.current).toBe("thinking");
    p.setState("listening");
    expect(p.current).toBe("aha");
    run(p, 0.41);
    expect(p.current).toBe("to_listening");
    run(p, 0.21);
    expect(p.current).toBe("listening");
    run(p, 2);
    expect(p.current).toBe("listening");
    expect(p.frame).toBe(2);
    p.setState("idle");
    expect(p.current).toBe("from_listening");
    run(p, 0.21);
    expect(p.current).toBe("idle");
  });

  it("queues requests during a transition and applies the latest one", () => {
    const p = new SpritePlayer(manifest(), null, noVariants);
    p.setState("thinking");
    p.setState("idle");
    expect(p.current).toBe("aha");
    p.setState("listening");
    p.setState("celebrate");
    run(p, 0.41);
    expect(p.current).toBe("celebrate");
  });

  it("returns a one-shot without hold to idle", () => {
    const p = new SpritePlayer(manifest(), null, noVariants);
    p.setState("celebrate");
    run(p, 0.3);
    expect(p.current).toBe("celebrate");
    run(p, 0.35);
    expect(p.current).toBe("idle");
    expect(p.requested).toBe("idle");
  });

  it("falls back to idle for unknown states and warns once", () => {
    const warnings: string[] = [];
    const p = new SpritePlayer(manifest(), null, { ...noVariants, warn: (m) => warnings.push(m) });
    p.setState("thinking");
    p.setState("nope");
    p.setState("nope");
    run(p, 0.5);
    expect(p.current).toBe("idle");
    expect(warnings).toHaveLength(1);
  });

  it("plays an idle variant after the gap and comes back to idle", () => {
    const p = new SpritePlayer(manifest(), null, { random: () => 0 });
    run(p, 4.05);
    expect(p.current).toBe("wave");
    run(p, 0.45);
    expect(p.current).toBe("idle");
  });

  it("skips variants and blinks under reduced motion", () => {
    const p = new SpritePlayer(manifest(), null, { random: () => 0 });
    p.setReducedMotion(true);
    run(p, 10);
    expect(p.current).toBe("idle");
  });

  it("override cuts in immediately and resume replays the enter transition", () => {
    const p = new SpritePlayer(manifest(), null, noVariants);
    p.setState("listening");
    run(p, 1);
    expect(p.current).toBe("listening");
    p.override("dragged");
    expect(p.current).toBe("dragged");
    run(p, 1);
    expect(p.current).toBe("dragged");
    p.override(null);
    expect(p.current).toBe("to_listening");
    run(p, 0.25);
    expect(p.current).toBe("listening");
  });

  it("runs the manifest jump steps, loops the wait step until ready, then resumes the request", async () => {
    const p = new SpritePlayer(manifest(), null, noVariants);
    const m = manifest();
    const out = p.runSequence(m.jump_sequence!.sending!);
    expect(p.current).toBe("hole_open");
    run(p, 0.31);
    await flush();
    expect(p.current).toBe("dive");
    run(p, 0.71);
    await flush();
    expect(p.current).toBe("hole_only");
    expect(p.frame).toBe(2);
    run(p, 0.31);
    await out;
    p.setHidden(true);
    expect(p.isHidden).toBe(true);

    let ready!: () => void;
    const handoff = new Promise<void>((r) => (ready = r));
    const back = p.runSequence(m.jump_sequence!.receiving!, handoff);
    expect(p.isHidden).toBe(false);
    p.setState("thinking");
    run(p, 0.31);
    await flush();
    expect(p.current).toBe("hole_wait");
    run(p, 2);
    expect(p.current).toBe("hole_wait");
    ready();
    await flush();
    expect(p.current).toBe("dive");
    run(p, 0.71);
    await flush();
    expect(p.current).toBe("hole_open");
    run(p, 0.31);
    await back;
    expect(p.current).toBe("thinking");
  });
});
