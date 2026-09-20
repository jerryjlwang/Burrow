// Map of the burrow: the concept graph drawn by hand on a canvas as pixel rooms and tunnels.
// d3-force lays it out; everything is drawn with fillRect on a 3px grid so it matches the rabbit
// and the frames. React only mounts it (Graph.tsx); this file owns the canvas, the loop and the mouse.
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { ConceptNode, EdgeType, GraphSnapshot, Misconception } from "@shared/graph";
import { ago } from "./data";

/** One drawn pixel, the same scale as the rabbit and the frames. */
const S = 3;
const HEIGHT = 420;
/** Below this the rabbit has forgotten the room (MASTERY.unseenThreshold in shared/src/graph.ts). */
const FORGOTTEN = 0.3;
/** Small, medium and large rooms: 14, 18 and 22 pixels a side. */
const SIZES = [42, 54, 66] as const;
/** Space under a room for its label. */
const LABEL_H = 21;
/** A shaky room's dot: one frame on, one frame off. Recurring ones blink twice as fast. */
const BLINK = { active: 600, recurring: 300 } as const;
/** Ticks until the layout rests: about two seconds at 60 frames a second. */
const SETTLE_TICKS = 120;
const FONT = '15px "Burrow Pixel", "Pixelify Sans", "Segoe UI", system-ui, sans-serif';
const MAX_LABEL_W = 165;

const C = {
  ink: "#3b2a23",
  cream: "#fff8e7",
  paper: "#fffdf5",
  teal: "#2f8f83",
  gold: "#f2c14e",
  red: "#d9534f",
  muted: "#7a6458",
  shadow: "rgba(59, 42, 35, 0.25)",
  grid: "rgba(59, 42, 35, 0.08)",
} as const;

const snap = (v: number): number => Math.round(v / S) * S;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

interface Room extends SimulationNodeDatum {
  id: string;
  label: string;
  /** The label as drawn, cut with dots when it would run too wide. */
  shown: string;
  size: number;
  half: number;
  mastery: number;
  seen: number;
  lastSeenAt: number;
  faded: boolean;
  /** The open misconception shown on the room, recurring before active. */
  shaky: Misconception | null;
  labelW: number;
  /** The paper plate under the label, never narrower than the room. */
  plateW: number;
  x: number;
  y: number;
}

interface Tunnel extends SimulationLinkDatum<Room> {
  source: Room;
  target: Room;
  type: EdgeType;
  weight: number;
}

interface Drag {
  room: Room;
  dx: number;
  dy: number;
  moved: boolean;
}

export interface GraphView {
  setGraph(graph: GraphSnapshot): void;
  destroy(): void;
}

/** Read by the scratch Playwright check so it can find rooms to hover and drag. */
export interface GraphDebug {
  rooms(): { id: string; x: number; y: number; size: number }[];
}

/** Mirrors the room card: the card says "Came up N times" from exposures plus asks. */
const timesSeen = (n: ConceptNode): number => Math.max(1, n.state.exposures + n.state.asks);

function openMisconception(n: ConceptNode): Misconception | null {
  return n.misconceptions.find((m) => m.status === "recurring") ?? n.misconceptions.find((m) => m.status === "active") ?? null;
}

/** Three sizes spread over the range seen in this graph, so a demo with five rooms shows all three. */
function sizeBand(seen: number, min: number, max: number): 0 | 1 | 2 {
  if (max <= min) return 1;
  const t = (seen - min) / (max - min);
  return t < 1 / 3 ? 0 : t < 2 / 3 ? 1 : 2;
}

/** Bresenham on the 3px grid: every cell the line crosses, as cell coordinates. */
function cellsBetween(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  let cx = Math.round(x0 / S);
  let cy = Math.round(y0 / S);
  const ex = Math.round(x1 / S);
  const ey = Math.round(y1 / S);
  const dx = Math.abs(ex - cx);
  const dy = -Math.abs(ey - cy);
  const sx = cx < ex ? 1 : -1;
  const sy = cy < ey ? 1 : -1;
  let err = dx + dy;
  const out: [number, number][] = [];
  for (;;) {
    out.push([cx, cy]);
    if (cx === ex && cy === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      cx += sx;
    }
    if (e2 <= dx) {
      err += dx;
      cy += sy;
    }
  }
  return out;
}

/** How far along a ray from (cx, cy) the box is left behind, or null when the ray misses it. */
function rayExit(cx: number, cy: number, vx: number, vy: number, left: number, right: number, top: number, bottom: number): number | null {
  let enter = -Infinity;
  let exit = Infinity;
  if (vx !== 0) {
    const a = (left - cx) / vx;
    const b = (right - cx) / vx;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  } else if (cx < left || cx > right) return null;
  if (vy !== 0) {
    const a = (top - cy) / vy;
    const b = (bottom - cy) / vy;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
  } else if (cy < top || cy > bottom) return null;
  return exit >= Math.max(enter, 0) ? exit : null;
}

/**
 * Where a tunnel from `from` meets `to`, one cell short of the wall, on the grid. The label plate
 * hangs under a room, so a tunnel that would cross it starts past the plate instead.
 */
function wallPoint(from: Room, to: Room): { x: number; y: number; ux: number; uy: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Walk out of `to` toward `from`.
  const vx = -ux;
  const vy = -uy;
  const room = rayExit(to.x, to.y, vx, vy, to.x - to.half, to.x + to.half, to.y - to.half, to.y + to.half) ?? to.half;
  const plate = rayExit(to.x, to.y, vx, vy, to.x - to.plateW / 2, to.x + to.plateW / 2, to.y + to.half + S, to.y + to.half + LABEL_H) ?? 0;
  const t = Math.max(room, plate) + S / Math.max(Math.abs(vx), Math.abs(vy));
  return { x: snap(to.x + vx * t), y: snap(to.y + vy * t), ux, uy };
}

export function mountGraph(host: HTMLElement, opts: { onPick: (id: string) => void }): GraphView {
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Map of what the rabbit has learned, drawn as rooms and tunnels");
  canvas.dataset.settled = "false";
  canvas.dataset.nodes = "0";
  const tip = document.createElement("div");
  tip.className = "graph-tip px-frame plain";
  tip.hidden = true;
  host.append(canvas, tip);
  const ctx = canvas.getContext("2d")!;

  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motion.matches;
  canvas.dataset.motion = reduced ? "reduced" : "full";

  let W = 0;
  const H = HEIGHT;
  let rooms: Room[] = [];
  let tunnels: Tunnel[] = [];
  let sim: Simulation<Room, Tunnel> | null = null;
  let hover: Room | null = null;
  let drag: Drag | null = null;
  let raf = 0;
  let dirty = true;
  let lastBlink = "";
  let settled = false;
  let pending: GraphSnapshot | null = null;

  // Labels are measured in the pixel font, so wait for it before the first layout.
  const fontsReady: Promise<unknown> = typeof document.fonts?.load === "function" ? document.fonts.load(FONT).catch(() => undefined) : Promise.resolve();

  /* ---------- sizing ---------- */

  function resize(): boolean {
    const w = Math.floor(host.clientWidth / S) * S;
    if (w <= 0 || w === W) return false;
    W = w;
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.imageSmoothingEnabled = false;
    return true;
  }

  function keepInside(r: Room): void {
    r.x = clamp(r.x, r.half + 2 * S, W - r.half - 2 * S);
    r.y = clamp(r.y, r.half + 2 * S, H - r.half - LABEL_H - 8 * S);
  }

  function measure(): void {
    ctx.font = FONT;
    for (const r of rooms) {
      let s = r.label;
      if (ctx.measureText(s).width > MAX_LABEL_W) {
        while (s.length > 1 && ctx.measureText(`${s.trimEnd()}...`).width > MAX_LABEL_W) s = s.slice(0, -1);
        s = `${s.trimEnd()}...`;
      }
      r.shown = s;
      r.labelW = Math.ceil(ctx.measureText(s).width);
      r.plateW = Math.max(r.size, Math.ceil((r.labelW + 2 * S) / S) * S);
    }
  }

  /* ---------- layout ---------- */

  function build(graph: GraphSnapshot, reheat: number): void {
    const prev = new Map(rooms.map((r) => [r.id, r]));
    const counts = graph.nodes.map(timesSeen);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    const n = graph.nodes.length;
    // New rooms start on a wide ellipse so the layout settles across the canvas, not in a knot.
    const rx = W / 3.2;
    const ry = H / 3.6;
    rooms = graph.nodes.map((node, i) => {
      const old = prev.get(node.id);
      const size = SIZES[sizeBand(counts[i], min, max)];
      const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
      return {
        id: node.id,
        label: node.label,
        shown: node.label,
        size,
        half: size / 2,
        mastery: clamp(node.state.mastery, 0, 1),
        seen: counts[i],
        lastSeenAt: node.state.lastSeenAt,
        faded: node.state.mastery < FORGOTTEN,
        shaky: openMisconception(node),
        labelW: 0,
        plateW: size,
        x: old?.x ?? W / 2 + Math.cos(a) * rx,
        y: old?.y ?? H / 2 + Math.sin(a) * ry,
      };
    });
    const byId = new Map(rooms.map((r) => [r.id, r]));
    tunnels = (graph.edges ?? []).flatMap((e) => {
      const source = byId.get(e.from);
      const target = byId.get(e.to);
      return source && target && source !== target ? [{ source, target, type: e.type, weight: clamp(e.weight, 0, 1) }] : [];
    });
    measure();
    hover = hover ? (byId.get(hover.id) ?? null) : null;
    if (hover) fillTip(hover);
    else tip.hidden = true;
    drag = null;
    canvas.dataset.nodes = String(rooms.length);

    sim?.stop();
    sim = forceSimulation<Room, Tunnel>(rooms)
      .alphaDecay(1 - Math.pow(0.001, 1 / SETTLE_TICKS))
      .velocityDecay(0.45)
      .force(
        "link",
        forceLink<Room, Tunnel>(tunnels)
          .distance((l) => 50 * S + Math.round((1 - l.weight) * 30) * S)
          .strength((l) => (l.type === "prerequisite" ? 0.9 : 0.5)),
      )
      .force("charge", forceManyBody<Room>().strength(-800))
      .force("collide", forceCollide<Room>((r) => Math.max(r.half + 8 * S, Math.min(r.labelW / 2 + 3 * S, r.half + 18 * S))).strength(0.9))
      .force("center", forceCenter(W / 2, H / 2))
      .force("x", forceX<Room>(W / 2).strength(0.02))
      .force("y", forceY<Room>(H / 2).strength(0.04))
      .alpha(reheat)
      .stop();
    settled = false;
    canvas.dataset.settled = "false";
    if (reduced) settleNow();
    dirty = true;
    wake();
  }

  /** Reduced motion: the layout still settles, it just does so before anyone sees it move. */
  function settleNow(): void {
    if (!sim) return;
    let guard = SETTLE_TICKS * 4;
    while (sim.alpha() > sim.alphaMin() && guard-- > 0) {
      sim.tick();
      rooms.forEach(keepInside);
    }
  }

  function recenter(): void {
    if (!sim) return;
    sim.force("center", forceCenter(W / 2, H / 2)).force("x", forceX<Room>(W / 2).strength(0.02)).force("y", forceY<Room>(H / 2).strength(0.04));
    rooms.forEach(keepInside);
    if (reduced) {
      sim.alpha(0.3);
      settleNow();
    } else {
      sim.alpha(Math.max(sim.alpha(), 0.3));
      settled = false;
      canvas.dataset.settled = "false";
    }
  }

  /* ---------- drawing ---------- */

  const px = (x: number, y: number, w = S, h = S): void => {
    ctx.fillRect(x, y, w, h);
  };

  function drawPaper(): void {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.grid;
    for (let y = 12; y < H; y += 24) for (let x = 12; x < W; x += 24) px(x, y);
  }

  /** A rounded square: the corner cells stay empty, the outline is one cell of ink. */
  function roomShape(x0: number, y0: number, size: number, outline: string, fill: string | null): void {
    ctx.fillStyle = outline;
    px(x0 + S, y0, size - 2 * S, S);
    px(x0 + S, y0 + size - S, size - 2 * S, S);
    px(x0, y0 + S, S, size - 2 * S);
    px(x0 + size - S, y0 + S, S, size - 2 * S);
    if (fill) {
      ctx.fillStyle = fill;
      px(x0 + S, y0 + S, size - 2 * S, size - 2 * S);
    }
  }

  function drawRoom(r: Room, lit: boolean, blinkOn: boolean): void {
    const x0 = snap(r.x - r.half);
    const y0 = snap(r.y - r.half);
    const size = r.size;

    ctx.globalAlpha = r.faded ? 0.55 : 1;
    // Crisp offset shadow, like the frames on the page.
    ctx.fillStyle = C.shadow;
    px(x0 + 2 * S, y0 + S, size - 2 * S, size);
    px(x0 + S, y0 + 2 * S, size, size - 2 * S);
    if (lit) roomShape(x0 - S, y0 - S, size + 2 * S, C.gold, null);
    roomShape(x0, y0, size, C.ink, C.cream);

    // A door: ink with a gold handle.
    const doorH = size === SIZES[0] ? 4 * S : 6 * S;
    const doorX = snap(r.x - 1.5 * S);
    ctx.fillStyle = C.ink;
    px(doorX, y0 + 2 * S, 3 * S, doorH);
    ctx.fillStyle = C.gold;
    px(doorX + 2 * S, y0 + 2 * S + Math.floor(doorH / 2 / S) * S, S, S);

    // Mastery bar along the bottom, filled in whole cells.
    const barX = x0 + 2 * S;
    const barY = y0 + size - 6 * S;
    const barW = size - 4 * S;
    ctx.fillStyle = C.ink;
    px(barX, barY, barW, 4 * S);
    ctx.fillStyle = C.paper;
    px(barX + S, barY + S, barW - 2 * S, 2 * S);
    const cells = (barW - 2 * S) / S;
    const filled = Math.round(r.mastery * cells);
    if (filled > 0) {
      ctx.fillStyle = C.teal;
      px(barX + S, barY + S, filled * S, 2 * S);
    }
    ctx.globalAlpha = 1;

    // Forgotten rooms get a cobweb in the top left corner: three short threads.
    if (r.faded) {
      ctx.fillStyle = C.muted;
      for (let i = 1; i <= 4; i++) px(x0 + i * S, y0 + i * S);
      for (let i = 0; i <= 3; i++) px(x0 + (4 - i) * S, y0 + (i + 1) * S);
      for (let i = 0; i <= 6; i++) px(x0 + (7 - i) * S, y0 + (i + 1) * S);
    }

    // An open misconception: a red dot on the top right corner.
    if (r.shaky && blinkOn) {
      ctx.fillStyle = C.red;
      px(x0 + size - 2 * S, y0 - S, 2 * S, 2 * S);
    }

    // The label sits on a paper plate so a tunnel passing under it never runs through the words.
    ctx.fillStyle = C.paper;
    px(snap(r.x - r.plateW / 2), y0 + size + S, r.plateW, LABEL_H - S);
    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = r.faded ? C.muted : C.ink;
    ctx.fillText(r.shown, snap(r.x), y0 + size + 2 * S);
  }

  function drawTunnel(t: Tunnel, lit: boolean, dim: boolean): void {
    const a = wallPoint(t.target, t.source);
    const b = wallPoint(t.source, t.target);
    const cells = cellsBetween(a.x, a.y, b.x, b.y);
    ctx.globalAlpha = dim ? 0.3 : 1;
    if (lit) {
      ctx.fillStyle = C.gold;
      for (const [cx, cy] of cells) px(cx * S - S, cy * S - S, 3 * S, 3 * S);
    }
    if (t.type === "prerequisite") {
      ctx.fillStyle = C.ink;
      for (const [cx, cy] of cells) px(cx * S, cy * S);
      // Arrow head: the tip plus two cells behind it, one each side.
      const back = { x: b.x - b.ux * S, y: b.y - b.uy * S };
      px(snap(back.x + b.uy * S), snap(back.y - b.ux * S));
      px(snap(back.x - b.uy * S), snap(back.y + b.ux * S));
    } else {
      ctx.fillStyle = C.teal;
      for (let i = 0; i < cells.length; i += 2) px(cells[i][0] * S, cells[i][1] * S);
    }
    ctx.globalAlpha = 1;
  }

  function drawLegend(): void {
    const y = H - 7 * S;
    let x = 4 * S;
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const word = (s: string): void => {
      ctx.fillStyle = C.muted;
      ctx.fillText(s, x, y + 2 * S);
      x += Math.ceil(ctx.measureText(s).width / S) * S + 5 * S;
    };
    roomShape(x, y, 4 * S, C.ink, C.cream);
    x += 6 * S;
    word("room");
    ctx.fillStyle = C.ink;
    px(x, y + S, 6 * S, S);
    px(x + 4 * S, y, S, S);
    px(x + 4 * S, y + 2 * S, S, S);
    x += 8 * S;
    word("tunnel");
    ctx.fillStyle = C.teal;
    for (let i = 0; i < 6; i += 2) px(x + i * S, y + S);
    x += 8 * S;
    word("related");
    ctx.fillStyle = C.red;
    px(x + S, y, 2 * S, 2 * S);
    x += 6 * S;
    word("shaky");
  }

  function blinkKey(t: number): string {
    if (reduced || !rooms.some((r) => r.shaky)) return "";
    return `${Math.floor(t / BLINK.active) % 2}${Math.floor(t / BLINK.recurring) % 2}`;
  }

  function blinkOn(r: Room, t: number): boolean {
    if (!r.shaky) return false;
    if (reduced) return true;
    const period = r.shaky.status === "recurring" ? BLINK.recurring : BLINK.active;
    return Math.floor(t / period) % 2 === 0;
  }

  function draw(t: number): void {
    drawPaper();
    const focus = drag?.room ?? hover;
    for (const tn of tunnels) {
      const touches = !!focus && (tn.source === focus || tn.target === focus);
      drawTunnel(tn, touches, !!focus && !touches);
    }
    for (const r of rooms) if (r !== focus) drawRoom(r, false, blinkOn(r, t));
    if (focus) drawRoom(focus, true, blinkOn(focus, t));
    drawLegend();
    if (hover && !drag) placeTip(hover);
  }

  /* ---------- tooltip ---------- */

  function fillTip(r: Room): void {
    tip.replaceChildren();
    const title = document.createElement("b");
    title.textContent = r.label;
    tip.append(title);
    const row = (text: string, key?: string): void => {
      const div = document.createElement("div");
      if (key) {
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = key;
        div.append(k);
      }
      div.append(text);
      tip.append(div);
    };
    row(`Holds ${Math.round(r.mastery * 100)}%${r.faded ? ", forgotten" : ""}`);
    row(`Came up ${r.seen === 1 ? "once" : `${r.seen} times`}`);
    row(`Last seen ${ago(r.lastSeenAt)}`);
    if (r.shaky) row(r.shaky.belief, r.shaky.status === "recurring" ? "Thinks again: " : "Thinks: ");
    tip.hidden = false;
  }

  function placeTip(r: Room): void {
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    // Clear the label plate too, so the room's own name stays readable.
    const reach = Math.max(r.half, r.plateW / 2);
    let left = snap(r.x + reach) + 4 * S;
    if (left + tw > W) left = snap(r.x - reach) - tw - 4 * S;
    let top = snap(r.y - r.half) - 2 * S;
    if (top + th > H) top = H - th;
    tip.style.left = `${Math.max(0, snap(left))}px`;
    tip.style.top = `${Math.max(0, snap(top))}px`;
  }

  function setHover(r: Room | null): void {
    if (r === hover) return;
    hover = r;
    canvas.dataset.hover = r ? r.id : "";
    canvas.style.cursor = r ? "grab" : "";
    if (r) fillTip(r);
    else tip.hidden = true;
    dirty = true;
    wake();
  }

  /* ---------- mouse ---------- */

  function pointOf(e: PointerEvent): { x: number; y: number } {
    const b = canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  function hit(p: { x: number; y: number }): Room | null {
    for (let i = rooms.length - 1; i >= 0; i--) {
      const r = rooms[i];
      if (p.x >= r.x - r.half && p.x <= r.x + r.half && p.y >= r.y - r.half && p.y <= r.y + r.half + LABEL_H) return r;
    }
    return null;
  }

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !sim) return;
    const p = pointOf(e);
    const r = hit(p);
    if (!r) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    r.fx = snap(r.x);
    r.fy = snap(r.y);
    drag = { room: r, dx: r.x - p.x, dy: r.y - p.y, moved: false };
    tip.hidden = true;
    canvas.style.cursor = "grabbing";
    sim.alphaTarget(0.3);
    if (sim.alpha() < 0.3) sim.alpha(0.3);
    settled = false;
    canvas.dataset.settled = "false";
    dirty = true;
    wake();
  };

  const onMove = (e: PointerEvent): void => {
    const p = pointOf(e);
    if (drag) {
      const r = drag.room;
      const nx = snap(clamp(p.x + drag.dx, r.half + 2 * S, W - r.half - 2 * S));
      const ny = snap(clamp(p.y + drag.dy, r.half + 2 * S, H - r.half - LABEL_H - 8 * S));
      if (nx !== r.x || ny !== r.y) drag.moved = true;
      r.fx = nx;
      r.fy = ny;
      r.x = nx;
      r.y = ny;
      dirty = true;
      wake();
      return;
    }
    setHover(hit(p));
  };

  const onUp = (e: PointerEvent): void => {
    if (!drag || !sim) return;
    const r = drag.room;
    const moved = drag.moved;
    r.fx = null;
    r.fy = null;
    drag = null;
    sim.alphaTarget(0);
    canvas.style.cursor = "grab";
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!moved) opts.onPick(r.id);
    if (hover) fillTip(hover);
    dirty = true;
    wake();
  };

  const onLeave = (): void => {
    if (!drag) setHover(null);
  };

  /* ---------- loop ---------- */

  function wake(): void {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(t: number): void {
    raf = 0;
    if (!sim) return;
    const ticking = sim.alpha() > sim.alphaMin();
    if (ticking) {
      sim.tick();
      rooms.forEach(keepInside);
      dirty = true;
    }
    const key = blinkKey(t);
    if (key !== lastBlink) {
      lastBlink = key;
      dirty = true;
    }
    if (dirty) {
      draw(t);
      dirty = false;
    }
    const rest = !(sim.alpha() > sim.alphaMin());
    if (rest !== settled) {
      settled = rest;
      canvas.dataset.settled = String(rest);
    }
    if (!rest || drag || key !== "") raf = requestAnimationFrame(frame);
  }

  /* ---------- wiring ---------- */

  const onMotion = (): void => {
    reduced = motion.matches;
    canvas.dataset.motion = reduced ? "reduced" : "full";
    if (reduced) settleNow();
    dirty = true;
    wake();
  };
  motion.addEventListener("change", onMotion);

  const ro = new ResizeObserver(() => {
    if (!resize()) return;
    if (sim) recenter();
    dirty = true;
    wake();
  });
  ro.observe(host);
  resize();

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);

  (canvas as HTMLCanvasElement & { __burrowGraph?: GraphDebug }).__burrowGraph = {
    rooms: () => rooms.map((r) => ({ id: r.id, x: r.x, y: r.y, size: r.size })),
  };

  return {
    setGraph(graph) {
      pending = graph;
      void fontsReady.then(() => {
        if (pending !== graph) return;
        resize();
        // A refreshed graph keeps its rooms where they were and only warms up a little.
        build(graph, rooms.length ? 0.6 : 1);
      });
    },
    destroy() {
      pending = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      sim?.stop();
      sim = null;
      ro.disconnect();
      motion.removeEventListener("change", onMotion);
      canvas.remove();
      tip.remove();
    },
  };
}
