import { spawn, wait, type ActDetail, type Piece, type PieceContext } from "./common";
import { burst, confetti, gather, trail, CREAM, GOLD, TEAL, WHITE } from "./particles";
import { whoosh } from "../tunnel";
import { FLIGHT } from "../pet/travel";

/** Actions this module acts out: the rabbit and the browser's tabs and pages. */
export const TAB_ACTIONS = new Set(["open_tab", "switch_tab", "navigate", "go_back"]);

/** Where his head should reach on the jump: just under the top edge, where the tab strip is. */
const APEX_Y = 6;
const CARD_W = 189;
const CHARGE_MS = 380;
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
 * open_tab, the set piece. He gathers himself (sparks drawn in, a glow at his feet), fires up the
 * screen on speed lines with a tail of sparks, punches the tab strip at the top (white flash, a
 * shock ring, a burst of two dozen pixels, the layer jolts), the new tab's card pops out of the
 * strip and leaves on a beam of light, and he drops back with a dust ring and a bow of confetti.
 */
async function openTab(d: ActDetail, ctx: PieceContext): Promise<void> {
  const pet = ctx.pet;
  const r = ctx.petRect();
  const text = host(d.url);
  if (pet && r && ready && ready.action === "open_tab" && Date.now() < ready.until) {
    // He is already up at the strip, charged: the punch lands the moment the decision does.
    const { home, timer } = ready;
    window.clearTimeout(timer);
    ready = null;
    void punch(ctx, pet, r, text, home);
    return;
  }
  if (!pet || !r || ctx.reduced) {
    await tabCard(ctx, r ? r.x + r.width / 2 : window.innerWidth - 120, text, "away");
    return;
  }
  const home = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  await charge(ctx, pet, r);
  const h = Math.max(60, r.top - APEX_Y);
  const vy = -Math.sqrt(2 * FLIGHT.gravity * h);
  const apexMs = Math.round((-vy / FLIGHT.gravity) * 1000);
  launch(ctx, r);
  const flight = pet.fling(0, vy);
  trailWhile(ctx, flight);
  await wait(Math.min(apexMs, 820));
  const at = ctx.petRect() ?? r;
  void impact(ctx, at, text).then(() => flight).then(() => landing(ctx, pet, home));
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

/** The hit at the top: flash, shock rings, a burst, a jolt, then the card. */
async function impact(ctx: PieceContext, at: DOMRect, text: string): Promise<void> {
  const tapX = at.x + at.width / 2 + 27;
  flash(ctx, 0.5);
  shake(ctx);
  shock(ctx, tapX, APEX_Y + 9, 150, 300, WHITE);
  shock(ctx, tapX, APEX_Y + 9, 90, 220, GOLD);
  burst(ctx.layer, tapX, APEX_Y + 12, 24, { lo: 200, hi: 520, colors: [CREAM, GOLD, TEAL], g: 640, life: 760, size: 3 });
  await tabCard(ctx, tapX, text, "away");
}

/** The landing: dust, a ring, a bow, and a little confetti for the judges. */
async function landing(ctx: PieceContext, pet: PieceContext["pet"], home: { x: number; y: number }): Promise<void> {
  const r = ctx.petRect();
  if (r) {
    shock(ctx, r.x + r.width / 2, r.y + r.height, 96, 260, CREAM);
    burst(ctx.layer, r.x + r.width / 2, r.y + r.height, 10, { lo: 80, hi: 260, colors: [CREAM], g: 900, life: 460 });
  }
  confetti(ctx.layer, home.x - 150, home.x + 150, 14);
  pet?.play("celebrate");
}

/** He is up at the strip already: punch, card, then home. */
async function punch(ctx: PieceContext, pet: PieceContext["pet"], r: DOMRect, text: string, home: { x: number; y: number }): Promise<void> {
  pet?.play("land");
  await impact(ctx, r, text);
  await wait(160);
  await pet?.goTo(home.x, home.y);
  await landing(ctx, pet, home);
}

/** He went up early on a guess and is waiting under the strip: where, since when, and where home is. */
let ready: { action: string; until: number; home: { x: number; y: number }; timer: number } | null = null;
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
  const x = Math.max(120, Math.min(window.innerWidth - 120, home.x));
  const timer = window.setTimeout(() => {
    if (ready?.timer !== timer) return;
    ready = null;
    void pet.goTo(home.x, home.y);
  }, READY_MS);
  ready = { action, until: Date.now() + READY_MS, home, timer };
  await charge(ctx, pet, r);
  speedLines(ctx, home.x, 520);
  await pet.goTo(x, APEX_Y + r.height / 2 + 3);
  const up = ctx.petRect();
  if (up && ready) {
    burst(ctx.layer, up.x + up.width / 2, up.y + up.height, 8, { lo: 60, hi: 200, colors: [GOLD], g: 500, life: 520 });
    spawn(ctx.layer, "pip-charge waiting", { left: `${Math.round(up.x + up.width / 2)}px`, top: `${Math.round(up.y + up.height)}px` }, READY_MS);
  }
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
