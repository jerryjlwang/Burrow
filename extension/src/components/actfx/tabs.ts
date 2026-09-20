import { spawn, wait, type ActDetail, type Piece, type PieceContext } from "./common";
import { burst, confetti, gather, trail, CREAM, GOLD, TEAL, WHITE } from "./particles";
import { dig, holeOf, tunnelIn, whoosh } from "../tunnel";
import { assetUrl } from "../pet";
import { FLIGHT } from "../pet/travel";

/** Actions this module acts out: the rabbit and the browser's tabs and pages. */
export const TAB_ACTIONS = new Set(["open_tab", "switch_tab", "navigate", "go_back"]);

/** Where his head should reach on the jump: just under the top edge, where the tab strip is. */
const APEX_Y = 6;
const CARD_W = 189;
const CHARGE_MS = 360;
/** The big card the new tab arrives as, centre stage, long enough to read. */
const BIG_W = 372;
const HOLD_MS = 620;
/** The signpost stands this long, long enough to read the place he is going. */
const SIGN_MS = 900;
/** The earth takes this long to close over the page (tunnel.ts TUNNEL_MS plus a beat). */
const TUNNEL_CLOSE_MS = 640;
const POP_MS = 240;
const AWAY_MS = 520;
const ACROSS_MS = 480;

const host = (url: string | null): string => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "new tab";
  } catch {
    return "new tab";
  }
};

/**
 * The page falls away: a dither of ink over everything, darkest at the edges, so the sparks and the
 * card read against it. It lifts at the end of the piece. Nothing under reduced motion.
 */
function dim(ctx: PieceContext): () => void {
  if (ctx.reduced) return () => undefined;
  const { el } = spawn(ctx.layer, "pip-actfx-dim", { backgroundImage: `url("${assetUrl("ui/guide/dim.png")}")` });
  return () => {
    el.classList.add("out");
    window.setTimeout(() => el.remove(), 320);
  };
}

/** Cracks running out from a hit, drawn in steps like a pane going. */
function cracks(ctx: PieceContext, x: number, y: number): void {
  for (let i = 0; i < 8; i++) {
    const { el } = spawn(ctx.layer, "pip-crack", { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` }, 620);
    el.style.setProperty("--a", `${(i / 8) * 360 + 12}deg`);
    el.style.setProperty("--len", `${120 + (i % 3) * 45}px`);
    el.style.animationDelay = `${(i % 4) * 25}ms`;
  }
}

/** A ring of pixels that expands from a point in steps and fades: the shock of an impact. */
function shock(ctx: PieceContext, x: number, y: number, to: number, ms: number, color = CREAM): void {
  const { el } = spawn(ctx.layer, "pip-shock", { left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, borderColor: color }, ms + 60);
  el.style.setProperty("--to", `${Math.round(to / 3) * 3}px`);
  el.style.setProperty("--ms", `${ms}ms`);
}

/** One frame of white over the page, gone in three steps. The impact reads even at a glance. */
function flash(ctx: PieceContext, alpha = 0.55): void {
  spawn(ctx.layer, "pip-flash", { opacity: String(alpha) }, 200);
}

/** Speed lines racing up beside a column, so the jump reads as fast. */
function speedLines(ctx: PieceContext, x: number, ms: number): void {
  for (let i = 0; i < 5; i++) {
    const { el } = spawn(ctx.layer, "pip-speedline", { left: `${Math.round((x + (i - 2) * 24) / 3) * 3}px` }, ms + 80);
    el.style.animationDelay = `${i * 40}ms`;
    el.style.setProperty("--ms", `${ms}ms`);
  }
}

/** The whole layer jolts one grid step and back: a hit you feel. */
function shake(ctx: PieceContext): void {
  ctx.layer.classList.add("shook");
  window.setTimeout(() => ctx.layer.classList.remove("shook"), 220);
}

/** Follow him while he flies and leave a trail of sparks behind his feet. */
function trailWhile(ctx: PieceContext, done: Promise<unknown>): void {
  let live = true;
  void done.then(() => {
    live = false;
  });
  const step = (): void => {
    if (!live) return;
    const r = ctx.petRect();
    if (r) trail(ctx.layer, r.x + r.width / 2, r.y + r.height, 2);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** A pixel tab card pops out of the top edge at x and slides up into the strip (or across it). */
async function tabCard(ctx: PieceContext, x: number, text: string, how: "away" | "across"): Promise<void> {
  const left = Math.round(Math.max(6, Math.min(window.innerWidth - CARD_W - 6, x - CARD_W / 2)) / 3) * 3;
  const { el, gone } = spawn(ctx.layer, "pip-tabcard", { left: `${how === "across" ? 6 : left}px`, top: "0px" });
  const ico = document.createElement("i");
  ico.className = "pip-tabcard-ico";
  const label = document.createElement("span");
  label.textContent = text;
  el.append(ico, label);
  if (ctx.reduced) {
    await wait(600);
    gone();
    return;
  }
  await wait(POP_MS + 120);
  if (how === "across") {
    el.style.setProperty("--run", `${window.innerWidth - CARD_W - 12}px`);
    spawn(ctx.layer, "pip-wipe", {}, ACROSS_MS + 60);
    el.classList.add("across");
    await wait(ACROSS_MS);
  } else {
    whoosh("up");
    // It leaves on a beam of light, shedding sparks as it goes.
    spawn(ctx.layer, "pip-beamup", { left: `${left + CARD_W / 2}px` }, AWAY_MS + 80);
    el.classList.add("away");
    for (let i = 0; i < 5; i++) {
      burst(ctx.layer, left + CARD_W / 2 + (Math.random() - 0.5) * CARD_W, 12 + i * 6, 4, { lo: 60, hi: 200, colors: [CREAM, GOLD], g: -140, life: 500, size: 3 });
      await wait(AWAY_MS / 5);
    }
  }
  gone();
}

/**
 * open_tab, the set piece: he takes the request down the burrow.
 *
 * A content script cannot draw into the browser's own chrome, so nothing here pretends to touch the
 * tab strip. The beat stays inside the page and uses the product's own language: he gathers himself,
 * a hole opens under him and clods fly while he digs, a signpost rises out of the hole with the site
 * on it, held long enough to read; he dives in after it, the earth closes over the whole page from
 * the edges in, and the tab opens on black. The cut is covered, so the new page simply is there.
 * When you come back to this page the earth lets go and he climbs out again.
 */
async function openTab(d: ActDetail, ctx: PieceContext): Promise<void> {
  const pet = ctx.pet;
  const r0 = ctx.petRect();
  const text = host(d.url);
  if (pet && r0 && ready && ready.action === "open_tab" && Date.now() < ready.until) {
    const { home, timer, lift } = ready;
    window.clearTimeout(timer);
    ready = null;
    await burrow(ctx, pet, text, home, lift);
    return;
  }
  if (!pet || !r0 || ctx.reduced) {
    await tabCard(ctx, r0 ? r0.x + r0.width / 2 : window.innerWidth - 120, text, "away");
    return;
  }
  const home = { x: r0.x + r0.width / 2, y: r0.y + r0.height / 2 };
  const lift = dim(ctx);
  await charge(ctx, pet, r0);
  await burrow(ctx, pet, text, home, lift);
}

/** The dig, the signpost, the dive and the earth closing. Resolves when the page is covered. */
async function burrow(ctx: PieceContext, pet: NonNullable<PieceContext["pet"]>, text: string, home: { x: number; y: number }, lift: () => void): Promise<void> {
  const hole = holeOf(pet);
  if (!hole) {
    await tabCard(ctx, home.x, text, "away");
    lift();
    return;
  }
  // He digs: clods of earth fly out of the hole while the ground gives way.
  const stop = dig(hole, ctx.reduced);
  shock(ctx, hole.x, hole.y, 150, 320, CREAM);
  burst(ctx.layer, hole.x, hole.y, 18, { lo: 140, hi: 420, colors: [CREAM, GOLD], g: 900, life: 700 });
  await wait(520);
  // The signpost rises out of the hole with the place he is going written on it.
  const post = signpost(ctx, hole.x, text);
  await wait(SIGN_MS);
  stop();
  lift();
  whoosh("down");
  // He goes down after it, and the earth closes over the page from the edges in.
  const earth = tunnelIn(hole, ctx.reduced);
  post.down();
  await Promise.all([pet.jumpOut(), wait(TUNNEL_CLOSE_MS)]);
  post.gone();
  // The page is covered: this is where the hold ends and the browser opens the tab on black.
  // Coming back to this page, the earth lets go and he climbs out again.
  void (async () => {
    await wait(900);
    await earth.out();
    await pet.jumpIn(wait(200));
    confetti(ctx.layer, 0, window.innerWidth, 24);
    pet.play("celebrate");
  })();
}

/**
 * A signpost rising out of the hole: the plank with the site's name on it, the way the meadow's
 * signs read, then it drops back into the hole ahead of him.
 */
function signpost(ctx: PieceContext, _x: number, text: string): { down: () => void; gone: () => void } {
  // Planted in the middle of the page, clear of him, so the name can be read whatever corner he digs in.
  const left = Math.round((window.innerWidth - BIG_W) / 2 / 3) * 3;
  const { el, gone } = spawn(ctx.layer, "pip-post", { left: `${left}px`, width: `${BIG_W}px` });
  el.style.bottom = `${Math.round(window.innerHeight * 0.16 / 3) * 3}px`;
  const board = document.createElement("div");
  board.className = "pip-post-board";
  const ico = document.createElement("i");
  ico.className = "pip-bigcard-ico";
  const label = document.createElement("span");
  label.textContent = text;
  const sub = document.createElement("b");
  sub.textContent = "opening a new tab";
  board.append(ico, label, sub);
  const leg = document.createElement("i");
  leg.className = "pip-post-leg";
  el.append(board, leg);
  if (!ctx.reduced) gather(ctx.layer, left + BIG_W / 2, Math.round(window.innerHeight * 0.68), 16, 180, 320, [GOLD, CREAM]);
  return {
    down: () => el.classList.add("down"),
    gone,
  };
}

/** The wind-up: sparks drawn into him from a ring, a glow under his feet, a crouch. */
async function charge(ctx: PieceContext, pet: PieceContext["pet"], r: DOMRect): Promise<void> {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  gather(ctx.layer, cx, cy, 14, 120, CHARGE_MS, [GOLD, CREAM]);
  spawn(ctx.layer, "pip-charge", { left: `${Math.round(cx)}px`, top: `${Math.round(r.y + r.height)}px` }, CHARGE_MS + 80);
  pet?.play("land");
  await wait(CHARGE_MS);
}

/** The launch: a ring of dust at his feet, sparks thrown down and out, speed lines up the column. */
function launch(ctx: PieceContext, r: DOMRect): void {
  const cx = r.x + r.width / 2;
  const fy = r.y + r.height;
  shock(ctx, cx, fy, 120, 320, CREAM);
  burst(ctx.layer, cx, fy, 14, { lo: 120, hi: 360, colors: [CREAM, GOLD], g: 700, life: 620 });
  speedLines(ctx, cx, 520);
  whoosh("up");
}

/**
 * The hit: a white flash, three shock rings, cracks running out, sixty pixels thrown, the layer jolts
 * twice. Then the new tab arrives as a card big enough to read in the middle of the screen, holds,
 * and rockets up to the strip on a beam with a comet of sparks behind it.
 */
async function impact(ctx: PieceContext, at: DOMRect, text: string): Promise<{ el: HTMLElement; gone: () => void; left: number; top: number }> {
  const x = Math.round(at.x + at.width / 2);
  const y = Math.round(APEX_Y + 30);
  flash(ctx, 0.75);
  shake(ctx);
  shock(ctx, x, y, 420, 420, WHITE);
  shock(ctx, x, y, 270, 340, GOLD);
  shock(ctx, x, y, 140, 260, CREAM);
  cracks(ctx, x, y);
  burst(ctx.layer, x, y, 60, { lo: 240, hi: 900, colors: [CREAM, GOLD, TEAL, WHITE], g: 520, life: 1000, size: 3 });
  whoosh("up");
  await wait(140);
  return cardIn(ctx, text);
}

/**
 * The card the new tab arrives as. `cardIn` grows it out of the hit and holds it where it can be
 * read; the piece's hold ends there, so the real tab opens next, and `cardAway` flies it up to the
 * strip as the browser puts the new tab in exactly that place.
 */
async function cardIn(ctx: PieceContext, text: string): Promise<{ el: HTMLElement; gone: () => void; left: number; top: number }> {
  const left = Math.round((window.innerWidth - BIG_W) / 2 / 3) * 3;
  const top = Math.round((window.innerHeight * 0.3) / 3) * 3;
  const { el, gone } = spawn(ctx.layer, "pip-bigcard", { left: `${left}px`, top: `${top}px`, width: `${BIG_W}px` });
  const ico = document.createElement("i");
  ico.className = "pip-bigcard-ico";
  const label = document.createElement("span");
  label.textContent = text;
  const sub = document.createElement("b");
  sub.textContent = "opening a new tab";
  el.append(ico, label, sub);
  if (ctx.reduced) {
    await wait(400);
    return { el, gone, left, top };
  }
  await wait(240);
  // A halo of sparks drawn in as it settles, so the eye goes to it.
  gather(ctx.layer, left + BIG_W / 2, top + 45, 18, 180, 300, [GOLD, CREAM]);
  await wait(HOLD_MS);
  return { el, gone, left, top };
}

async function cardAway(ctx: PieceContext, card: { el: HTMLElement; gone: () => void; left: number; top: number }): Promise<void> {
  if (ctx.reduced) {
    card.gone();
    return;
  }
  spawn(ctx.layer, "pip-beamup", { left: `${card.left + BIG_W / 2}px` }, AWAY_MS + 120);
  card.el.classList.add("away");
  for (let i = 0; i < 6; i++) {
    burst(ctx.layer, card.left + BIG_W / 2 + (Math.random() - 0.5) * BIG_W, card.top - i * 24, 6, { lo: 80, hi: 300, colors: [CREAM, GOLD], g: -180, life: 620, size: 3 });
    await wait(AWAY_MS / 6);
  }
  card.gone();
}



/** He went up early on a guess and is waiting under the strip: where, since when, and where home is. */
let ready: { action: string; until: number; home: { x: number; y: number }; timer: number; lift: () => void } | null = null;
const READY_MS = 9000;

/**
 * A request that reads like a tab request: he charges and travels up to the strip now, while the
 * model decides, and waits there with a glow. If the decision comes he punches at once; if nothing
 * comes he goes back home.
 */
export async function anticipateTabPiece(action: "open_tab", ctx: PieceContext): Promise<void> {
  const pet = ctx.pet;
  const r = ctx.petRect();
  if (!pet || !r || ctx.reduced || ready) return;
  const home = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  const lift = dim(ctx);
  const timer = window.setTimeout(() => {
    if (ready?.timer !== timer) return;
    ready = null;
    lift();
    void pet.goTo(home.x, home.y);
  }, READY_MS);
  ready = { action, until: Date.now() + READY_MS, home, timer, lift };
  // He does not travel: he crouches where he is and keeps a glow while the model decides.
  await charge(ctx, pet, r);
  if (ready) spawn(ctx.layer, "pip-charge waiting", { left: `${Math.round(r.x + r.width / 2)}px`, top: `${Math.round(r.y + r.height)}px` }, READY_MS);
}

/** switch_tab: a wave, and the card slides along the strip behind a teal wipe. */
async function switchTab(_d: ActDetail, ctx: PieceContext): Promise<void> {
  ctx.pet?.play("wave");
  await tabCard(ctx, 0, "your tab", "across");
}

/** navigate and go_back: the address or back card presses in at the top left, he waves, then dives ahead. */
async function goSomewhere(d: ActDetail, ctx: PieceContext): Promise<void> {
  const back = d.action === "go_back";
  const { el, gone } = spawn(ctx.layer, "pip-navcard", {}, ctx.reduced ? 700 : 1100);
  el.textContent = back ? "\u2190 back" : `\u2192 ${host(d.url)}`;
  if (ctx.reduced) return;
  await wait(200);
  el.classList.add("press");
  ctx.pet?.play("wave");
  const r = ctx.petRect();
  if (r) burst(ctx.layer, r.x + r.width / 2, r.y + r.height, 8, { lo: 80, hi: 240, colors: [CREAM, GOLD], g: 800, life: 500 });
  await wait(300);
  gone();
  await ctx.pet?.jumpOut();
}

export const playTabPiece: Piece<ActDetail> = (d, ctx) => {
  switch (d.action) {
    case "open_tab":
      return openTab(d, ctx);
    case "switch_tab":
      return switchTab(d, ctx);
    case "navigate":
    case "go_back":
      return goSomewhere(d, ctx);
    default:
      return undefined;
  }
};
