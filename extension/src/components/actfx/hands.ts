import { playCue, voiceBlip } from "../sounds";
import { HOLD_MS, grid, spawn, standBeside, wait, type ActDetail, type Piece, type PieceContext, type Rect } from "./common";
import { CELL, ENTER_ARROW, MENU, PENCIL, SPARKLE, paint, ringShadow } from "./hands-glyphs";

/** Actions this module acts out: the rabbit's paws on the page. */
export const HAND_ACTIONS = new Set(["click", "double_click", "right_click", "hover", "drag", "press_key", "press_enter", "type", "clear", "select", "focus", "scroll", "scroll_to"]);

/**
 * Hands on the page. He goes to stand beside the target (hops along his row, the hole for anything
 * further) and the press lands with the action: the executor waits for the piece's hold, and each piece
 * resolves it at the moment of its press, never later than DEADLINE_MS. What is left of the show (the
 * ring fading, letters still dropping, a late arrival patting the thing) carries on after the hold.
 *
 * click, double_click, right_click: the `land` squash on him with a teal pixel ring that grows over four
 * steps and fades, four cream sparks on whole-pixel arcs and a soft tap; two rings for a double click, a
 * small pixel menu card for a right click. hover: a `wave` and a ring that breathes twice. type: cream
 * letter tiles pop in above the field one every 40 ms with a voice blip while a pixel pencil writes them,
 * then the word drops into the field. clear: blank tiles fly out backwards under a sweep. press_key and
 * press_enter: a key cap bounces in at the field's right end and presses in as he stamps. scroll and
 * scroll_to: he hops in place and three speed lines streak along the viewport edge. drag: a dotted trail
 * to the drop point and he tows a dashed ghost of the element along it. select and focus: a gold glint.
 * Reduced motion: no travel, the mark appears whole for a moment and the hold resolves at once.
 */
export const playHandsPiece: Piece<ActDetail> = (detail, ctx) => {
  const run = PIECES[detail.action];
  return run ? hold(run)(detail, ctx) : undefined;
};

/** The latest a hold may resolve: a margin under the executor's ACT_HOLD_MS so the press always beats its timer. */
const DEADLINE_MS = HOLD_MS - 120;
/** One step of a ring. */
const STEP_MS = 80;
/** The box drawn around a bare point. */
const POINT_BOX = 28;
/** He is already within reach when his body is this close to the target. */
const NEAR_X = 60;
const NEAR_Y = 24;
const TYPE_CAP = 24;
const LETTER_MS = 40;
/** A letter tile with its border, and a blank one for clear. */
const LETTER_W = 21;
const LETTER_H = 27;
const BLANK_W = 24;
const KEY_H = 30;
const TEAL = "#2f8f83";
const GOLD = "#f2c14e";
const KEY_NAMES: Record<string, string> = { " ": "Space", Escape: "Esc", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Backspace: "Back", Delete: "Del", Enter: "Enter", Tab: "Tab" };

type Done = () => void;
type Run = (detail: ActDetail, ctx: PieceContext, done: Done) => Promise<void>;

/**
 * A piece's hold resolves when it calls `done` (its press), when it finishes, or at the deadline,
 * whichever comes first. Errors inside a piece end the hold and go no further.
 */
function hold(run: Run): Piece<ActDetail> {
  return (detail, ctx) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, DEADLINE_MS);
      let p: Promise<void>;
      try {
        p = run(detail, ctx, done);
      } catch {
        p = Promise.resolve();
      }
      p.catch(() => undefined).then(done);
    });
}

/* ---------- where ---------- */

/** The target's box: the element's rect, or a small box around the point. */
function target(detail: ActDetail): Rect | null {
  const r = detail.rect;
  if (r && r.width > 0 && r.height > 0) return r;
  const p = detail.point;
  if (p) return { x: p.x - POINT_BOX / 2, y: p.y - POINT_BOX / 2, width: POINT_BOX, height: POINT_BOX };
  return null;
}

/** The target's centre cell on the 3px grid. */
function centre(r: Rect): { x: number; y: number } {
  return { x: grid(r.x + r.width / 2), y: grid(r.y + r.height / 2) };
}

/** Whether his body already stands within reach of the rect: beside it, or on it. */
function near(body: DOMRect, r: Rect): boolean {
  return body.right >= r.x - NEAR_X && body.left <= r.x + r.width + NEAR_X && body.bottom >= r.y - NEAR_Y && body.top <= r.y + r.height + NEAR_Y;
}

/**
 * Go and stand beside the rect. Resolves once he is there, and right away when he is already near,
 * when the art has not loaded, or under reduced motion.
 */
function travel(ctx: PieceContext, r: Rect): Promise<void> {
  const pet = ctx.pet;
  const body = ctx.petRect();
  if (!pet || ctx.reduced || !body || body.width === 0 || near(body, r)) return Promise.resolve();
  const stand = standBeside(r, body);
  return Promise.resolve()
    .then(() => pet.goTo(Math.round(stand.x), Math.round(stand.y)))
    .catch(() => undefined);
}

/** Start the trip and remember whether it has ended. */
function trip(ctx: PieceContext, r: Rect): { arrived: Promise<void>; there: () => boolean } {
  let done = false;
  const arrived = travel(ctx, r).then(() => {
    done = true;
  });
  return { arrived, there: () => done };
}

/** Wait for the trip, but no longer than `ms`. */
function upTo(arrived: Promise<void>, ms: number): Promise<void> {
  return Promise.race([arrived, wait(Math.max(0, ms))]).then(() => undefined);
}

/* ---------- marks ---------- */

/**
 * A pixel ring on the target: one cell thick, the radii in cells shown one after another every
 * `stepMs`, the last one dimmed when it fades. Under reduced motion it is a six cell ring, whole and still.
 */
function ring(ctx: PieceContext, x: number, y: number, colour: string, radii: number[] = [2, 4, 6, 8], stepMs = STEP_MS, fade = true): void {
  const still = ctx.reduced;
  const { el } = spawn(ctx.layer, "pip-hand-ring", { left: `${x}px`, top: `${y}px` }, still ? 450 : stepMs * radii.length + 20);
  if (still) {
    el.style.boxShadow = ringShadow(6, colour);
    return;
  }
  el.style.boxShadow = ringShadow(radii[0], colour);
  radii.forEach((r, i) => {
    if (i === 0) return;
    window.setTimeout(() => {
      el.style.boxShadow = ringShadow(r, colour);
      if (fade && i === radii.length - 1) el.classList.add("dim");
    }, i * stepMs);
  });
}

/** Four cream sparks fly out of the target on whole-pixel arcs. */
function sparks(layer: HTMLElement, x: number, y: number): void {
  const kinds: [string, number][] = [
    ["high", -1],
    ["high", 1],
    ["low", -1],
    ["low", 1],
  ];
  for (const [arc, sx] of kinds) {
    const { el } = spawn(layer, `pip-hand-spark ${arc}`, { left: `${x - 3}px`, top: `${y - 3}px` }, 340);
    el.style.setProperty("--sx", String(sx));
  }
}

/** The tap: his squash, the ring (two for a double click), the sparks and one soft cue. */
function tap(ctx: PieceContext, x: number, y: number, rings: 1 | 2, squash: boolean): void {
  if (squash) ctx.pet?.play("land");
  ring(ctx, x, y, TEAL);
  if (rings === 2) window.setTimeout(() => ring(ctx, x, y, TEAL), 140);
  sparks(ctx.layer, x, y);
  playCue("land");
}

/** A tiny menu card pops out beside the click and goes away. */
function menu(layer: HTMLElement, x: number, y: number): void {
  let left = x + 9;
  let top = y + 9;
  if (left + MENU.w > window.innerWidth - 6) left = x - 9 - MENU.w;
  if (top + MENU.h > window.innerHeight - 6) top = y - 9 - MENU.h;
  const { el } = spawn(layer, "pip-hand-menu", { left: `${left}px`, top: `${top}px` }, 720);
  paint(el, MENU);
}

/** Four sparkles on the diagonals of the glint, blinking. */
function sparkles(layer: HTMLElement, x: number, y: number, ms: number): void {
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const { el } = spawn(layer, "pip-hand-sparkle", { left: `${x + sx * 24 - 6}px`, top: `${y + sy * 24 - 6}px` }, ms);
    paint(el, SPARKLE);
  }
}

/** One letter tile above the field. `dir` is 1 when the tiles drop down into the field, -1 when they rise into it. */
function tile(layer: HTMLElement, ch: string, x: number, y: number, dir: 1 | -1, still: boolean, ms = 0): HTMLElement {
  const { el } = spawn(layer, `pip-hand-letter${still ? " still" : ""}`, { left: `${x}px`, top: `${y}px` }, ms);
  el.textContent = ch;
  el.style.setProperty("--dir", String(dir));
  return el;
}

/** The label on a key cap for what the executor presses. */
function keyLabel(text: string | null): string {
  const t = (text ?? "").trim() || (text === " " ? " " : "");
  if (!t) return "Key";
  if (KEY_NAMES[t]) return KEY_NAMES[t];
  return t.length === 1 ? t.toUpperCase() : t.slice(0, 8);
}

/** Three speed lines along the right edge of the viewport, streaking the way the page goes. */
function streaks(layer: HTMLElement, dir: "up" | "down", still: boolean): void {
  const h = window.innerHeight;
  const lines: [number, number, number][] = [
    [15, 36, 0],
    [27, 60, 60],
    [39, 45, 120],
  ];
  for (const [fromRight, len, delay] of lines) {
    const start = dir === "down" ? grid(h * 0.15) + delay : grid(h * 0.85) - len - delay;
    const { el } = spawn(layer, `pip-hand-streak ${dir}${still ? " still" : ""}`, { left: `${window.innerWidth - fromRight}px`, top: `${start}px`, height: `${len}px` }, still ? 400 : 480 + delay + 40);
    el.style.animationDelay = `${delay}ms`;
  }
}

/* ---------- the pieces ---------- */

const click =
  (kind: "click" | "double" | "right"): Run =>
  async (detail, ctx, done) => {
    const r = target(detail);
    if (!r) {
      ctx.pet?.play("land");
      done();
      return;
    }
    const c = centre(r);
    if (ctx.reduced) {
      ring(ctx, c.x, c.y, TEAL);
      if (kind === "right") menu(ctx.layer, c.x, c.y);
      done();
      return;
    }
    const t = trip(ctx, r);
    await upTo(t.arrived, DEADLINE_MS - 60);
    // The press lands with the click. If he is still on his way, the ring marks it and he pats it when he gets there.
    tap(ctx, c.x, c.y, kind === "double" ? 2 : 1, t.there());
    if (kind === "right") menu(ctx.layer, c.x, c.y);
    done();
    if (!t.there()) {
      await t.arrived;
      ctx.pet?.play("land");
      ring(ctx, c.x, c.y, TEAL, [2, 4, 5]);
    }
  };

const hover: Run = async (detail, ctx, done) => {
  const r = target(detail);
  if (!r) {
    done();
    return;
  }
  const c = centre(r);
  if (ctx.reduced) {
    ring(ctx, c.x, c.y, TEAL);
    done();
    return;
  }
  const t = trip(ctx, r);
  await upTo(t.arrived, DEADLINE_MS - 60);
  ctx.pet?.play("wave");
  ring(ctx, c.x, c.y, TEAL, [4, 6, 4, 6, 4], 120, false);
  done();
};

const type: Run = async (detail, ctx, done) => {
  const r = target(detail);
  const text = (detail.text ?? "").replace(/\s+/g, " ").slice(0, TYPE_CAP);
  if (!r || !text.trim()) {
    done();
    return;
  }
  const x0 = grid(r.x) + 6;
  const above = r.y - LETTER_H - 6 - 24 >= 0;
  const dir: 1 | -1 = above ? 1 : -1;
  const yRest = above ? grid(r.y) - LETTER_H - 6 : grid(r.y + r.height) + 6;
  const n = Math.min(text.length, Math.floor((window.innerWidth - 12 - x0) / LETTER_W));
  if (n <= 0) {
    done();
    return;
  }
  if (ctx.reduced) {
    for (let i = 0; i < n; i++) if (text[i] !== " ") tile(ctx.layer, text[i], x0 + i * LETTER_W, yRest, dir, true, 700);
    done();
    return;
  }
  const t = trip(ctx, r);
  // Start writing in time for a short word to drop in at the deadline; a long one keeps going after it.
  await upTo(t.arrived, DEADLINE_MS - (n * LETTER_MS + 180));
  const pencil = spawn(ctx.layer, "pip-hand-pencil", {}).el;
  const pencilTop = above && yRest - PENCIL[0].h + 3 >= 0 ? yRest - PENCIL[0].h + 3 : yRest - 12;
  pencil.style.top = `${pencilTop}px`;
  const tiles: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const x = x0 + i * LETTER_W;
    pencil.style.left = `${x + 9}px`;
    paint(pencil, PENCIL[i % 2]);
    if (ch !== " ") {
      tiles.push(tile(ctx.layer, ch, x, yRest, dir, false));
      if (i % 2 === 0 && /[a-z0-9]/i.test(ch)) voiceBlip(ch.charCodeAt(0));
    }
    await wait(LETTER_MS);
  }
  await wait(120);
  pencil.classList.add("away");
  window.setTimeout(() => pencil.remove(), 200);
  // The word drops into the field as the real text lands.
  done();
  tiles.forEach((el, i) => window.setTimeout(() => el.classList.add("in"), i * 20));
  await wait(tiles.length * 20 + 280);
  for (const el of tiles) el.remove();
};

const clear: Run = async (detail, ctx, done) => {
  const r = target(detail);
  if (!r) {
    done();
    return;
  }
  const n = Math.min(8, Math.floor((r.width - 12) / BLANK_W));
  if (n <= 0) {
    done();
    return;
  }
  const x0 = grid(r.x) + 6;
  const y = grid(r.y + r.height / 2) - 12;
  if (ctx.reduced) {
    for (let i = 0; i < n; i++) spawn(ctx.layer, "pip-hand-blank still", { left: `${x0 + i * BLANK_W}px`, top: `${y}px` }, 450);
    done();
    return;
  }
  const t = trip(ctx, r);
  await upTo(t.arrived, DEADLINE_MS - 300);
  // The blanks leave from the right end first, and the sweep follows them out.
  for (let i = 0; i < n; i++) {
    const delay = (n - 1 - i) * 30;
    const { el } = spawn(ctx.layer, "pip-hand-blank", { left: `${x0 + i * BLANK_W}px`, top: `${y}px` }, delay + 280);
    el.style.animationDelay = `${delay}ms`;
  }
  const dx = -Math.max(24, Math.floor((r.width - 36) / 24) * 24);
  const right = grid(r.x + r.width) - 12;
  const sweeps: [number, number, number][] = [
    [24, 3, 0],
    [36, 12, 40],
    [30, 21, 80],
  ];
  for (const [len, dy, delay] of sweeps) {
    const { el } = spawn(ctx.layer, "pip-hand-sweep", { left: `${right - len}px`, top: `${y + dy}px`, width: `${len}px` }, delay + 360);
    el.style.setProperty("--dx", `${dx}px`);
    el.style.animationDelay = `${delay}ms`;
  }
  playCue("hole_open");
  done();
};

const press =
  (enterKey: boolean): Run =>
  async (detail, ctx, done) => {
    const r = target(detail);
    const label = enterKey ? "Enter" : keyLabel(detail.text);
    const arrow = enterKey || label === "Enter";
    const t = r ? trip(ctx, r) : null;
    if (t && !ctx.reduced) await upTo(t.arrived, DEADLINE_MS - 330);
    const key = spawn(ctx.layer, `pip-hand-key${ctx.reduced ? " down" : " drop"}`, {}, ctx.reduced ? 500 : 0).el;
    const text = document.createElement("span");
    text.textContent = label;
    key.appendChild(text);
    if (arrow) {
      const box = document.createElement("span");
      box.className = "pip-hand-key-arrow";
      const g = document.createElement("i");
      paint(g, ENTER_ARROW);
      box.appendChild(g);
      key.appendChild(box);
    }
    const w = Math.ceil(key.offsetWidth / CELL) * CELL;
    key.style.width = `${w}px`;
    // At the field's right end, or over his head when the key goes to the page itself.
    let left: number;
    let top: number;
    const body = ctx.petRect();
    if (r) {
      left = Math.max(grid(r.x) + 6, grid(r.x + r.width) - w - 6);
      top = grid(r.y + (r.height - KEY_H) / 2);
    } else if (body && body.width > 0) {
      left = grid(body.left + (body.width - w) / 2);
      top = grid(body.top) - KEY_H - 24;
    } else {
      left = grid((window.innerWidth - w) / 2);
      top = grid(window.innerHeight * 0.8);
    }
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - KEY_H - 9));
    key.style.left = `${left}px`;
    key.style.top = `${top}px`;
    if (ctx.reduced) {
      done();
      return;
    }
    await wait(240);
    key.classList.add("down");
    ctx.pet?.play("land");
    playCue("chalk");
    done();
    await wait(150);
    key.classList.remove("down");
    await wait(360);
    key.remove();
  };

const scroll: Run = async (detail, ctx, done) => {
  const r = target(detail);
  const dir: "up" | "down" = detail.direction ?? (r ? (r.y + r.height / 2 < window.innerHeight / 2 ? "up" : "down") : "down");
  if (ctx.reduced) {
    streaks(ctx.layer, dir, true);
    done();
    return;
  }
  // He crouches into a hop in place, and the page goes as he lands.
  ctx.pet?.play("hop");
  if (r && detail.action === "scroll_to") {
    const c = centre(r);
    ring(ctx, c.x, c.y, TEAL, [4, 6, 6], 120, false);
  }
  await wait(250);
  streaks(ctx.layer, dir, false);
  done();
  await wait(180);
  ctx.pet?.play("land");
};

const drag: Run = async (detail, ctx, done) => {
  const r = target(detail);
  if (!r) {
    done();
    return;
  }
  const from = centre(r);
  const to = detail.point ? { x: grid(detail.point.x), y: grid(detail.point.y) } : { x: from.x + 60, y: from.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const count = Math.max(2, Math.min(40, Math.round(Math.hypot(dx, dy) / 12)));
  const dotAt = (i: number) => ({ x: grid(from.x + (dx * i) / count), y: grid(from.y + (dy * i) / count) });
  const w = grid(Math.min(r.width, 150));
  const h = grid(Math.min(r.height, 90));
  const ghostAt = (k: number) => ({ left: Math.round(from.x + (dx * k) / 8 - w / 2 + 1), top: Math.round(from.y + (dy * k) / 8 - h / 2 + 1) });
  if (ctx.reduced) {
    for (let i = 0; i <= count; i++) {
      const p = dotAt(i);
      spawn(ctx.layer, "pip-hand-dot", { left: `${p.x}px`, top: `${p.y}px` }, 500);
    }
    const g = ghostAt(8);
    spawn(ctx.layer, "pip-hand-ghost", { left: `${g.left}px`, top: `${g.top}px`, width: `${w}px`, height: `${h}px` }, 500);
    done();
    return;
  }
  const t = trip(ctx, r);
  await upTo(t.arrived, DEADLINE_MS - 260);
  // The trail draws out from the element to the drop point over 200 ms, and each dot lives until the
  // tow is done and its turn comes to go, first dot first.
  const gap = Math.min(15, Math.floor(200 / count));
  const towEnd = count * gap + 8 * 40 + 60;
  for (let i = 0; i <= count; i++) {
    const p = dotAt(i);
    window.setTimeout(() => spawn(ctx.layer, "pip-hand-dot", { left: `${p.x}px`, top: `${p.y}px` }, towEnd - i * gap + i * 12), i * gap);
  }
  await wait(count * gap);
  // He tows it: the ghost slides along in eight steps while he hops.
  const g0 = ghostAt(0);
  const ghost = spawn(ctx.layer, "pip-hand-ghost", { left: `${g0.left}px`, top: `${g0.top}px`, width: `${w}px`, height: `${h}px` }).el;
  ctx.pet?.play("hop");
  done();
  for (let k = 1; k <= 8; k++) {
    await wait(40);
    const g = ghostAt(k);
    ghost.style.left = `${g.left}px`;
    ghost.style.top = `${g.top}px`;
  }
  ctx.pet?.play("land");
  playCue("land");
  ring(ctx, to.x, to.y, TEAL, [2, 4, 5]);
  await wait(160);
  ghost.remove();
};

const glint: Run = async (detail, ctx, done) => {
  const r = target(detail);
  if (!r) {
    done();
    return;
  }
  const c = centre(r);
  if (!ctx.reduced) await upTo(travel(ctx, r), DEADLINE_MS - 200);
  ring(ctx, c.x, c.y, GOLD, [5, 6, 6, 6], 90, false);
  if (!ctx.reduced) window.setTimeout(() => sparkles(ctx.layer, c.x, c.y, 270), 90);
  done();
};

const PIECES: Record<string, Run> = {
  click: click("click"),
  double_click: click("double"),
  right_click: click("right"),
  hover,
  type,
  clear,
  press_key: press(false),
  press_enter: press(true),
  scroll,
  scroll_to: scroll,
  drag,
  select: glint,
  focus: glint,
};
