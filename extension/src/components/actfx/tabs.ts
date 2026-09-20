import { spawn, wait, type ActDetail, type Piece, type PieceContext } from "./common";
import { whoosh } from "../tunnel";
import { FLIGHT } from "../pet/travel";

/** Actions this module acts out: the rabbit and the browser's tabs and pages. */
export const TAB_ACTIONS = new Set(["open_tab", "switch_tab", "navigate", "go_back"]);

/** Where his head should reach on the jump: just under the top edge, where the tab strip is. */
const APEX_Y = 6;
const CARD_W = 189;
const POP_MS = 240;
const AWAY_MS = 420;
const ACROSS_MS = 480;

const host = (url: string | null): string => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "new tab";
  } catch {
    return "new tab";
  }
};

/** A few cream flecks flying out from a point, on whole pixels. */
function dust(ctx: PieceContext, x: number, y: number, up: boolean): void {
  for (let i = 0; i < 4; i++) {
    const { el } = spawn(ctx.layer, "pip-dust", { left: `${Math.round(x + (i - 1.5) * 9)}px`, top: `${Math.round(y)}px` }, AWAY_MS + 60);
    el.style.setProperty("--dx", `${Math.round((i - 1.5) * 18)}px`);
    el.style.setProperty("--dy", `${up ? -18 - (i % 2) * 9 : 12 + (i % 2) * 9}px`);
    el.style.animationDelay = `${i * 30}ms`;
  }
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
    dust(ctx, left + CARD_W / 2, 30, true);
    el.classList.add("away");
    await wait(AWAY_MS);
  }
  gone();
}

/** open_tab: he jumps up, taps the strip at the top of the jump, the card pops and flies up, he lands with a bounce. */
async function openTab(d: ActDetail, ctx: PieceContext): Promise<void> {
  const pet = ctx.pet;
  const r = ctx.petRect();
  const text = host(d.url);
  if (!pet || !r || ctx.reduced) {
    await tabCard(ctx, r ? r.x + r.width / 2 : window.innerWidth - 120, text, "away");
    return;
  }
  const h = Math.max(60, r.top - APEX_Y);
  const vy = -Math.sqrt(2 * FLIGHT.gravity * h);
  const apexMs = Math.round((-vy / FLIGHT.gravity) * 1000);
  const flight = pet.fling(0, vy);
  await wait(Math.min(apexMs, 860));
  const tapX = r.x + r.width / 2 + 27;
  dust(ctx, tapX, APEX_Y + 3, false);
  const card = tabCard(ctx, tapX, text, "away");
  await flight;
  pet.play("celebrate");
  await card;
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
  el.textContent = back ? "← back" : `→ ${host(d.url)}`;
  if (ctx.reduced) return;
  await wait(200);
  el.classList.add("press");
  ctx.pet?.play("wave");
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
