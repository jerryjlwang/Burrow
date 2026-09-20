/**
 * The set piece on both ends of the jump between laptops (docs/frontend/HANDOFF.md). When he leaves,
 * the page darkens to dirt from the edges in around the hole and the notes he carries drop in after
 * him. While the other side waits, dirt flies out of its hole; when he pops out, the notes unroll
 * beside him and what he learned types out inside. handoff.ts calls these at the right moments.
 *
 * Everything is drawn inside the companion's shadow root, one step under the rabbit, so the page
 * never sees it and the pieces share the pixel grid, palette and font of the kid UI. The one sound
 * here is the tunnel whoosh: sounds.ts owns the state cues and is not touched.
 */
import { HOST_ID } from "../page-understanding/extract";
import { journeyOn, type Journey } from "./journey";
import { store } from "../content/store";
import { plainCopy } from "./copy";
import { assetUrl, type PetController } from "./pet";
import { voiceBlip } from "./sounds";

/** Where the hole is on screen, in viewport pixels, and the rabbit's draw scale. */
export interface Hole {
  x: number;
  y: number;
  scale: number;
}

export interface Tunnel {
  /** The dirt lets go of the page, from the hole back out to the edges, then goes away. */
  out(): Promise<void>;
}

export interface Notes {
  /** Roll the notes back up now instead of after their time. */
  dismiss(): void;
}

/** The hole sits on the cell's center column over rows 50 to 55 (tools/sprites/rabbit_px.py). */
const HOLE_COL = 32;
const HOLE_ROW = 52.5;
/** The dirt closes in over this many steps, and lets go over the same. Must match styles.css. */
const TUNNEL_STEPS = 8;
const TUNNEL_MS = 560;
/** Clear radius left around the hole once the dirt has closed in, in the rabbit's source pixels. */
const CLEAR_RADIUS = 20;
/** Each dither band (25, 50, 75 percent) is this wide, in px. */
const BAND = 30;
/** The rolled notes: seven 18px steps into the hole. Must match styles.css. */
const DROP_MS = 420;
/** The unrolled notes grow this much per step while they unroll. */
const UNROLL_STEP = 18;
const UNROLL_TICK_MS = 45;
/** The rods are the 15px border-image edges; rolled up, the notes are just the two rods. */
const ROLLED_HEIGHT = 30;
const NOTES_WIDTH = 330;
const NOTES_GAP = 18;
const EDGE = 12;
/** Same pace as the speech bubble, so his notes read like his voice. */
const CHARS_PER_SECOND = 42;
const TYPE_TICK_MS = 40;
/** The four dirt layers, sparsest first (drawn underneath) to full on top. */
const DENSITIES = [25, 50, 75, 100] as const;
/** Clods of dirt flying out of the hole: side, arc and shade, with a start offset into the loop. */
const CLODS: [string, number][] = [
  ["r near", 0],
  ["l far light", -240],
  ["r high big", -480],
  ["l near big", -120],
  ["r far light", -600],
  ["l high", -360],
  ["l far big", -660],
  ["r near light", -300],
  ["l high light", -540],
  ["r far big", -180],
];
const PIECES: [string, string][] = [
  ["--ui-dirt", "ui/dirt.png"],
  ["--ui-dirt-75", "ui/dirt_75.png"],
  ["--ui-dirt-50", "ui/dirt_50.png"],
  ["--ui-dirt-25", "ui/dirt_25.png"],
  ["--ui-scroll", "ui/scroll.png"],
  ["--ui-scroll-rolled", "ui/scroll_rolled.png"],
];

function shadow(): ShadowRoot | null {
  return document.getElementById(HOST_ID)?.shadowRoot ?? null;
}

/** The layer everything here draws into: a sibling of the React root, under it. Made once. */
function layer(): HTMLElement | null {
  const root = shadow();
  if (!root) return null;
  let el = root.querySelector<HTMLElement>(".pip-tunnel-root");
  if (!el) {
    el = document.createElement("div");
    el.className = "pip-tunnel-root";
    el.setAttribute("aria-hidden", "true");
    for (const [name, file] of PIECES) el.style.setProperty(name, `url("${assetUrl(file)}")`);
    // Before the React container so the rabbit, his bubble and the panel stay on top of it.
    const container = Array.from(root.children).find((c) => c.tagName === "DIV") ?? null;
    root.insertBefore(el, container);
  }
  return el;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The hole's center on screen, from the pet's cell. Works while he is hidden in it. */
export function holeOf(pet: PetController): Hole | null {
  const cell = shadow()?.querySelector<HTMLElement>(".pet");
  const r = cell?.getBoundingClientRect();
  if (!r || r.width === 0) return null;
  const s = pet.scale;
  const bodyLeft = pet.manifest.body?.[0] ?? 0;
  return { x: Math.round(r.left - bodyLeft * s + HOLE_COL * s), y: Math.round(r.top + HOLE_ROW * s), scale: s };
}

/**
 * The page darkens to dirt from the edges in, in eight steps, until only a small circle around the
 * hole is clear. Four layers of the same earth at 25, 50, 75 and 100 percent Bayer density close in
 * together, so the edge of the dark is a dither fringe, not a soft gradient. Nothing under reduced motion.
 */
export function tunnelIn(hole: Hole, reduced: boolean): Tunnel {
  const root = layer();
  if (!root || reduced) return { out: () => Promise.resolve() };
  const w = window.innerWidth;
  const h = window.innerHeight;
  const far = Math.ceil(Math.max(Math.hypot(hole.x, hole.y), Math.hypot(w - hole.x, hole.y), Math.hypot(hole.x, h - hole.y), Math.hypot(w - hole.x, h - hole.y)));
  const clear = 2 * CLEAR_RADIUS * hole.scale;
  // Even sizes keep the circle centred on whole pixels at every step.
  const step = 2 * Math.ceil((2 * far + 2 * BAND - clear) / TUNNEL_STEPS / 2);
  const layers = DENSITIES.map((density, i) => {
    const el = document.createElement("div");
    el.className = `pip-tunnel d${density}`;
    const d1 = clear + i * 2 * BAND;
    el.style.setProperty("--hx", `${hole.x}px`);
    el.style.setProperty("--hy", `${hole.y}px`);
    el.style.setProperty("--d0", `${d1 + TUNNEL_STEPS * step}px`);
    el.style.setProperty("--d1", `${d1}px`);
    root.appendChild(el);
    return el;
  });
  let done = false;
  return {
    out: async () => {
      if (done) return;
      done = true;
      for (const el of layers) el.classList.add("out");
      await wait(TUNNEL_MS + 40);
      for (const el of layers) el.remove();
    },
  };
}

/** The rolled notes tumble down into the open hole after him. Resolves once they are in. */
export function dropNotes(hole: Hole, reduced: boolean): Promise<void> {
  const root = layer();
  if (!root || reduced) return Promise.resolve();
  const box = document.createElement("div");
  box.className = "pip-drop";
  // The box's bottom edge is the hole's surface line, so the notes vanish as they pass it.
  box.style.left = `${hole.x - 60}px`;
  box.style.top = `${hole.y - 120}px`;
  const notes = document.createElement("div");
  notes.className = "pip-drop-notes";
  box.appendChild(notes);
  root.appendChild(box);
  return wait(DROP_MS + 60).then(() => box.remove());
}

/** Dirt flies out of the hole in a short loop while he is on his way. Returns the stop function. */
export function dig(hole: Hole, reduced: boolean): () => void {
  const root = layer();
  if (!root || reduced) return () => undefined;
  const box = document.createElement("div");
  box.className = "pip-dig";
  box.style.left = `${hole.x}px`;
  box.style.top = `${hole.y}px`;
  // Clod sizes and arcs are in units of the rabbit's pixel, so a 4x rabbit throws 4x dirt.
  box.style.setProperty("--u", `${hole.scale}px`);
  for (const [kind, delay] of CLODS) {
    const clod = document.createElement("span");
    clod.className = `pip-clod ${kind}`;
    clod.style.animationDelay = `${delay}ms`;
    box.appendChild(clod);
  }
  root.appendChild(box);
  return () => box.remove();
}

/**
 * The notes unroll beside him and the text types out inside, with the voice blips of the bubble.
 * They roll back up after `ms`, or on a click once the typing is done; a click while typing shows
 * the whole text at once. Under reduced motion they appear whole and still.
 */
export function unrollNotes(pet: PetController, text: string, opts: { ms: number; reduced: boolean }): Notes {
  const root = layer();
  const body = pet.getBodyRect();
  if (!root || !body || body.width === 0) return { dismiss: () => undefined };
  for (const old of root.querySelectorAll(".pip-notes")) old.remove();
  const copy = plainCopy(text);
  const el = document.createElement("div");
  el.className = `pip-notes${opts.reduced ? " still" : " pop typing"}`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const p = document.createElement("p");
  p.className = "pip-notes-text";
  const head = document.createElement("span");
  const caret = document.createElement("span");
  caret.className = "pip-notes-caret";
  const rest = document.createElement("span");
  rest.className = "pip-notes-rest";
  rest.textContent = copy;
  p.append(head, caret, rest);
  el.appendChild(p);

  // Beside him, clear of the talk button at his side: on his left when there is room, otherwise on
  // his right, with the bottom rod on his feet line.
  const talk = shadow()?.querySelector<HTMLElement>(".pip-talk")?.getBoundingClientRect();
  const leftEdge = Math.min(body.left, talk && talk.width > 0 ? talk.left : body.left);
  const rightEdge = Math.max(body.right, talk && talk.width > 0 ? talk.right : body.right);
  const width = Math.min(NOTES_WIDTH, window.innerWidth - 2 * EDGE);
  el.style.width = `${width}px`;
  let left = Math.round(leftEdge) - NOTES_GAP - width;
  if (left < EDGE) left = Math.round(rightEdge) + NOTES_GAP;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
  el.style.left = `${left}px`;
  root.appendChild(el);
  const full = el.offsetHeight;
  el.style.top = `${Math.max(EDGE, Math.round(body.bottom) - full)}px`;

  let timer = 0;
  let shown = 0;
  let typed = opts.reduced;
  let gone = false;
  const showAll = () => {
    shown = copy.length;
    head.textContent = copy;
    rest.textContent = "";
    caret.remove();
    el.classList.remove("typing");
    typed = true;
  };
  const remove = () => {
    if (gone) return;
    gone = true;
    window.clearTimeout(timer);
    el.remove();
  };
  const rollUp = () => {
    if (gone) return;
    let h = full;
    const shrink = () => {
      h = Math.max(ROLLED_HEIGHT, h - 2 * UNROLL_STEP);
      el.style.height = `${h}px`;
      if (h > ROLLED_HEIGHT && !opts.reduced) timer = window.setTimeout(shrink, UNROLL_TICK_MS);
      else remove();
    };
    shrink();
  };
  const settle = () => {
    timer = window.setTimeout(rollUp, opts.ms);
  };
  const type = () => {
    const start = performance.now();
    const tick = () => {
      if (typed) return;
      const n = document.visibilityState === "hidden" ? copy.length : Math.min(copy.length, Math.floor(((performance.now() - start) / 1000) * CHARS_PER_SECOND));
      if (n !== shown) {
        for (let i = shown; i < Math.min(n, shown + 8); i++) {
          const ch = copy[i];
          if (/[a-z]/i.test(ch) && i % 2 === 0) voiceBlip(ch.charCodeAt(0));
        }
        shown = n;
        head.textContent = copy.slice(0, n);
        rest.textContent = copy.slice(n);
      }
      if (n < copy.length) timer = window.setTimeout(tick, TYPE_TICK_MS);
      else {
        showAll();
        settle();
      }
    };
    timer = window.setTimeout(tick, TYPE_TICK_MS);
  };
  if (opts.reduced) {
    showAll();
    settle();
  } else {
    // Unroll from the top rod down in whole steps, then start writing.
    let h = ROLLED_HEIGHT;
    el.style.height = `${h}px`;
    const grow = () => {
      h = Math.min(full, h + UNROLL_STEP);
      el.style.height = `${h}px`;
      if (h < full) timer = window.setTimeout(grow, UNROLL_TICK_MS);
      else type();
    };
    timer = window.setTimeout(grow, UNROLL_TICK_MS);
  }
  el.addEventListener("click", () => {
    if (!typed) {
      window.clearTimeout(timer);
      el.style.height = `${full}px`;
      showAll();
      settle();
    } else {
      window.clearTimeout(timer);
      rollUp();
    }
  });
  return { dismiss: () => rollUp() };
}

/* ---------- the journey ---------- */

/**
 * The big sound of the trip to the other screen (see journey.ts): starts as he goes under, and
 * `emerge(inMs)` lands the burst on the moment he should pop out over there. Null before the
 * page has had its click, or with sound off, like the whoosh.
 */
export function journey(): Journey | null {
  const ac = audio();
  return ac ? journeyOn(ac, ac.destination) : null;
}

/* ---------- the whoosh ---------- */

let ctx: AudioContext | null = null;

/** A context of its own, running only once the page has had a click; silent before that, like sounds.ts. */
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

/** Filtered noise sweeping down the tunnel with a square glide under it, or the same coming up. */
export function whoosh(direction: "down" | "up"): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  const secs = 0.6;
  const frames = Math.floor(ac.sampleRate * secs);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const noise = ac.createBufferSource();
  noise.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 1.4;
  const [f0, f1] = direction === "down" ? [1800, 140] : [140, 1800];
  filter.frequency.setValueAtTime(f0, t);
  filter.frequency.exponentialRampToValueAtTime(f1, t + secs);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.11, t + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + secs);
  noise.connect(filter).connect(gain).connect(ac.destination);
  noise.start(t);
  noise.stop(t + secs + 0.02);
  const osc = ac.createOscillator();
  osc.type = "square";
  const [p0, p1] = direction === "down" ? [620, 70] : [70, 620];
  osc.frequency.setValueAtTime(p0, t);
  osc.frequency.exponentialRampToValueAtTime(p1, t + secs * 0.85);
  const og = ac.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(0.03, t + 0.03);
  og.gain.exponentialRampToValueAtTime(0.0001, t + secs * 0.9);
  osc.connect(og).connect(ac.destination);
  osc.start(t);
  osc.stop(t + secs);
}
