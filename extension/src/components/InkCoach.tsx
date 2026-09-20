import { useEffect, useRef, useState, type RefObject } from "react";
import type { InkBox, InkJudgement } from "@shared/ink";
import { parseSketch, type SketchItem, type Stroke } from "@shared/sketch";
import type { Rect } from "@shared/types";
import { sendToBackground, type InkStageDetail } from "../shared/messages";
import { store, useStore } from "../content/store";
import { HOST_ID } from "../page-understanding/extract";
import { pageRole } from "./handoff";
import { besidePoint, type PetController } from "./pet";
import { playCue } from "./sounds";

/**
 * The tablet coach, on the drawing board page only. The proactive engine hands it each ink
 * verdict it decided to act on as a `burrow:ink` stage, and the coach makes the picture before
 * the voice starts:
 *
 * - nudge: the rabbit hops (or hole-travels) to stand beside the wrong line, then a chalk ring
 *   is drawn around the exact part the judge marked, with the chalk squeak. The ring fades on
 *   its own, or the moment a later verdict says the line is fixed.
 * - note: he goes to the empty part of the board the judge found and his chalkboard rises
 *   beside him with the note, written out line by line as ever.
 * - clear: the ring comes off; on solved work the note board goes too.
 *
 * Boxes arrive as fractions of the captured frame, which is this page's viewport, so they map
 * straight onto CSS pixels. A stage the coach claims calls `done` once its picture is in place.
 */
const MARK_PAD = 10;
/** The ring stays while the kid thinks; a later verdict clears it the moment the line is right. */
const MARK_TTL_MS = 120_000;
/** Must match pip-inkmark-out in styles.css. */
const MARK_OUT_MS = 300;
const RING_DRAW_MS = 680;
const NOTE_RISE_MS = 600;
/** He does not bother moving for a target this close to where he already stands. */
const STAY_PX = 40;
/** How often the board page tells the watcher where its own UI is. */
const MASK_EVERY_MS = 120;
/** Quiet spells asked of the watcher: a hop plus the ring and the bubble typing; a hop plus the board rising and being written. */
const QUIET_NUDGE_MS = 5000;
const QUIET_NOTE_MS = 8000;
/** A stroke this soon after the note board went up is a tap while looking, not writing; it stays. */
const NOTE_PEN_GRACE_MS = 2500;

/** Tells the watcher where the companion's UI is right now, and optionally to look away for a while. */
function reportMask(quietMs?: number): void {
  const viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  sendToBackground({ type: "tablet.mask", rects: ownUiRects(), viewport, ...(quietMs ? { quietMs } : {}) }, 2000).catch(() => undefined);
}
/** The parts of the companion's UI the watcher must not read as ink. */
const MASK_SELECTORS = [".pip-dock", ".pip-board", ".pip-inkmark", ".pip-sketch", ".pip-plan", ".pip-pen"];

const toRect = (b: InkBox): Rect => ({ x: b.x * window.innerWidth, y: b.y * window.innerHeight, width: b.w * window.innerWidth, height: b.h * window.innerHeight });

/**
 * The rabbit's body size for placing him: his body box when he is on screen, else the manifest's
 * body at his scale (while he is in a hole the box measures zero, and a zero-sized body would put
 * his corner, not his side, on the target).
 */
function bodySize(p: PetController | null, body: DOMRect | null): { width: number; height: number } {
  if (body && body.width > 0 && body.height > 0) return { width: body.width, height: body.height };
  const b = p?.manifest.body;
  const s = p?.scale ?? 3;
  return b ? { width: Math.max(1, b[2] - b[0]) * s, height: Math.max(1, b[3] - b[1]) * s } : { width: 93, height: 159 };
}

/** A judge's empty area must be at least this much of the viewport each way to hold him and the board. */
const SPACE_MIN_FRAC = 0.3;
/** Room kept between the wrong line and the empty area, in CSS pixels. */
const SPACE_CLEAR_PX = 24;
/** How far in from the viewport edge he stands in a corner. */
const CORNER_PAD = 16;

/**
 * Where he stands for a note. The judge's empty area is used only when it is big enough and does
 * not touch the wrong line; the judge is loose about "empty" and a board over the kid's work is
 * the one place it must not go. Otherwise the bottom corner farther from the wrong line: the kid's
 * work sits in the middle of the page, and the corners stay clear.
 */
export function noteSpot(j: InkJudgement, size: { width: number; height: number }, vw: number, vh: number): { x: number; y: number } {
  const line = j.box ?? j.mark;
  const lineRect = line ? toRect(line) : null;
  const space = j.space ? toRect(j.space) : null;
  if (space && space.width >= vw * SPACE_MIN_FRAC && space.height >= vh * SPACE_MIN_FRAC) {
    const clear =
      !lineRect ||
      lineRect.x + lineRect.width + SPACE_CLEAR_PX <= space.x ||
      space.x + space.width + SPACE_CLEAR_PX <= lineRect.x ||
      lineRect.y + lineRect.height + SPACE_CLEAR_PX <= space.y ||
      space.y + space.height + SPACE_CLEAR_PX <= lineRect.y;
    if (clear) return { x: space.x + space.width - size.width / 2 - CORNER_PAD, y: space.y + space.height - size.height / 2 };
  }
  const lineMid = lineRect ? lineRect.x + lineRect.width / 2 : vw / 2;
  const right = lineMid <= vw / 2;
  return { x: right ? vw - size.width / 2 - CORNER_PAD : size.width / 2 + CORNER_PAD, y: vh - size.height / 2 - CORNER_PAD };
}

/** The companion's own UI as fractions of the viewport, for the watcher's mask. */
function ownUiRects(): InkBox[] {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) return [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: InkBox[] = [];
  for (const sel of MASK_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ x: Math.round((r.x / vw) * 1e4) / 1e4, y: Math.round((r.y / vh) * 1e4) / 1e4, w: Math.round((r.width / vw) * 1e4) / 1e4, h: Math.round((r.height / vh) * 1e4) / 1e4 });
    }
  }
  return out;
}

/**
 * A hand-drawn ring for a w x h box: an ellipse that wobbles a little, drifts outward as it goes
 * round, and runs a bit past a full turn so the end overlaps the start the way a pen does.
 */
export function ringPath(w: number, h: number, seed = 1): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = Math.max(6, w / 2 - 3);
  const ry = Math.max(6, h / 2 - 3);
  // Where the pen lands and how far past the turn it runs vary with the seed, so no two rings look stamped.
  const u = (Math.abs(seed) % 997) / 997;
  const start = 2.2 + u * 0.9;
  const sweep = Math.PI * 2 * (1.06 + u * 0.14);
  const n = 56;
  const phase = u * Math.PI * 2;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const t = start + (sweep * i) / n;
    const wobble = 1 + 0.045 * Math.sin(3 * t + phase) + 0.03 * Math.sin(5 * t - phase);
    const drift = (i / n) * 2.2;
    const x = cx + (rx * wobble + drift) * Math.cos(t);
    const y = cy + (ry * wobble + drift) * Math.sin(t);
    pts.push(`${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

interface Mark {
  id: number;
  rect: Rect;
}

/** The pen note: lines and shapes he writes straight onto the board's canvas, in black, in the empty space. */
interface PenNote {
  id: number;
  rect: Rect;
  title?: string;
  items: SketchItem[];
}
/** One item (a written line, a shape) lands every so often, like a hand writing. */
const PEN_STEP_MS = 520;
const PEN_LINE_PX = 30;
const PEN_MAX_W = 460;
const PEN_MIN_W = 240;
/** Space the excalidraw toolbar takes at the top, and the pad from any edge. */
const PEN_TOP_CLEAR = 110;
const PEN_PAD = 20;

/**
 * Where the pen note goes: inside the judge's empty area when it is big enough, leaving the
 * rabbit his room at its lower right; else the top left of the canvas under the toolbar, which the
 * kid's work (in the middle) and the rabbit (in a corner below) leave clear. Never over the wrong line.
 */
export function penRect(j: InkJudgement | null, items: SketchItem[], size: { width: number; height: number }, vw: number, vh: number): Rect {
  const textLines = items.filter((it) => it.kind === "text").length + 1;
  const hasShapes = items.some((it) => it.kind === "stroke");
  const wantH = textLines * PEN_LINE_PX + (hasShapes ? 200 : 0) + 12;
  const space = j?.space ? toRect(j.space) : null;
  if (space && space.width >= PEN_MIN_W + size.width + PEN_PAD * 2 && space.height >= 120) {
    const width = Math.max(PEN_MIN_W, Math.min(PEN_MAX_W, space.width - size.width - PEN_PAD * 3));
    const height = Math.min(wantH, Math.max(120, space.height - PEN_PAD * 2));
    return { x: space.x + PEN_PAD, y: Math.max(PEN_TOP_CLEAR, space.y + PEN_PAD), width, height };
  }
  const width = Math.max(PEN_MIN_W, Math.min(PEN_MAX_W, vw * 0.36));
  return { x: PEN_PAD + 60, y: PEN_TOP_CLEAR, width, height: Math.min(wantH, vh - PEN_TOP_CLEAR - PEN_PAD) };
}

/** A shape in the pen note's own pixels, drawn once in black ink. */
function PenShape({ stroke, w, h }: { stroke: Stroke; w: number; h: number }) {
  const unit = Math.min(w, h) / 100;
  const X = (v: number) => (v * w) / 100;
  const Y = (v: number) => (v * h) / 100;
  const [a, b, c, d] = stroke.n;
  const common = { fill: "none", stroke: "#1b1b1b", strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, pathLength: 100, className: "pip-pen-stroke" };
  switch (stroke.kind) {
    case "line":
      return <path d={`M ${X(a)} ${Y(b)} L ${X(c)} ${Y(d)}`} {...common} />;
    case "arrow": {
      const ang = Math.atan2(Y(d) - Y(b), X(c) - X(a));
      const len = Math.max(9, 4 * unit);
      const flick = (off: number) => `M ${X(c)} ${Y(d)} L ${X(c) - len * Math.cos(ang + off)} ${Y(d) - len * Math.sin(ang + off)}`;
      return <path d={`M ${X(a)} ${Y(b)} L ${X(c)} ${Y(d)} ${flick(0.5)} ${flick(-0.5)}`} {...common} />;
    }
    case "circle":
      return <circle cx={X(a)} cy={Y(b)} r={c * unit} {...common} />;
    case "rect":
      return <rect x={X(a)} y={Y(b)} width={X(c)} height={Y(d)} {...common} />;
    case "dot":
      return <circle cx={X(a)} cy={Y(b)} r={Math.max(3, 1.3 * unit)} fill="#1b1b1b" stroke="none" />;
    default:
      return null;
  }
}


/** How long a stage may take before the caller goes on without it (a hole trip is about 2.5 s). */
const STAGE_TIMEOUT_MS = 4000;

/**
 * Hands a stage (the hop to the ink, the ring, the note board) to the coach through a cancelable
 * `burrow:ink` event and resolves once its picture is in place, so the voice lands on it. A page
 * with no coach (the kid's laptop) resolves at once.
 */
export function stageInk(detail: Omit<InkStageDetail, "done">): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(done, STAGE_TIMEOUT_MS);
    const claimed = !window.dispatchEvent(new CustomEvent<InkStageDetail>("burrow:ink", { cancelable: true, detail: { ...detail, done } }));
    if (!claimed) done();
  });
}

/** Ring a part of the handwriting on request (the model's point_to on the board): the hop and the ring, no words of the coach's own. */
export function markInkAt(mark: InkBox, box: InkBox | null): Promise<void> {
  const judgement: InkJudgement = { lines: [], status: "off", line: null, box: box ?? mark, mark, issue: "", nudge: "", confidence: 1, solved: false, note: [], space: null };
  return stageInk({ phase: "nudge", judgement, rung: 1 });
}

export function InkCoach({ pet }: { pet: RefObject<PetController | null> }) {
  const reduced = useStore((s) => s.reducedMotion);
  const [mark, setMark] = useState<Mark | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pen, setPen] = useState<PenNote | null>(null);
  const [penShown, setPenShown] = useState(0);
  const lastJudgement = useRef<InkJudgement | null>(null);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  // The watcher captures this tab, rabbit and all: keep it told where the companion's UI is.
  useEffect(() => {
    if (pageRole() !== "board") return;
    let last = "";
    const report = () => {
      const key = JSON.stringify(ownUiRects());
      if (key === last) return;
      last = key;
      reportMask();
    };
    report();
    const timer = window.setInterval(report, MASK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (pageRole() !== "board") return;
    const onStage = (e: Event) => {
      const d = (e as CustomEvent<InkStageDetail>).detail;
      if (!d?.judgement) return;
      const j = d.judgement;
      if (j.space || j.box) lastJudgement.current = j;
      if (d.phase === "clear") {
        setMark((m) => (m ? { ...m, id: -Math.abs(m.id) } : null));
        setLeaving(true);
        if (j.solved) {
          store.setState((s) => (s.board?.id.startsWith("ink-") ? { board: null } : {}));
          setPen(null);
        }
        return;
      }
      const p = pet.current;
      const body = p?.getBodyRect() ?? null;
      const size = bodySize(p, body);
      const center = body && body.width > 0 ? { x: body.left + body.width / 2, y: body.top + body.height / 2 } : null;
      if (d.phase === "note" && j.note.length) {
        e.preventDefault();
        reportMask(QUIET_NOTE_MS);
        void (async () => {
          if (p) {
            // He stands clear of the ink; the chalkboard rises beside him, on the side with room.
            const { x, y } = noteSpot(j, size, window.innerWidth, window.innerHeight);
            if (!center || Math.hypot(x - center.x, y - center.y) >= STAY_PX) await p.goTo(x, y);
          }
          const sk = parseSketch(j.note.join("\n"));
          if (sk.items.length) {
            playCue("chalk");
            setPen({ id: Date.now(), rect: penRect(j, sk.items, size, window.innerWidth, window.innerHeight), title: sk.title, items: sk.items });
          }
          window.setTimeout(d.done, reducedRef.current ? 0 : NOTE_RISE_MS);
        })();
        return;
      }
      if (d.phase === "nudge" && (j.mark || j.box)) {
        e.preventDefault();
        reportMask(QUIET_NUDGE_MS);
        void (async () => {
          const line = toRect(j.box ?? j.mark!);
          const part = toRect(j.mark ?? j.box!);
          if (p) {
            const to = besidePoint(line, size.width, size.height, window.innerWidth);
            if (!center || Math.hypot(to.x - center.x, to.y - center.y) >= STAY_PX) await p.goTo(to.x, to.y);
          }
          playCue("chalk");
          setLeaving(false);
          setMark({ id: Date.now(), rect: part });
          window.setTimeout(d.done, reducedRef.current ? 0 : RING_DRAW_MS);
        })();
      }
    };
    window.addEventListener("burrow:ink", onStage);
    return () => window.removeEventListener("burrow:ink", onStage);
  }, [pet]);

  // The note board leaves when the pen comes back: the first stroke on the page after the board has
  // been up a moment takes it down, so it never sits over the work they are doing next.
  const inkBoardAt = useStore((s) => (s.board?.id.startsWith("ink-") ? Number(s.board.id.slice(4)) : 0));
  useEffect(() => {
    if (pageRole() !== "board" || !inkBoardAt) return;
    const host = document.getElementById(HOST_ID);
    const onPen = (e: PointerEvent) => {
      if (Date.now() - inkBoardAt < NOTE_PEN_GRACE_MS) return;
      if (host && e.composedPath().includes(host)) return;
      store.setState((s) => (s.board?.id.startsWith("ink-") ? { board: null } : {}));
    };
    document.addEventListener("pointerdown", onPen, true);
    return () => document.removeEventListener("pointerdown", onPen, true);
  }, [inkBoardAt]);

  // "Draw it out" on the board: the agent's sketch is written in pen on the canvas, not on a chalkboard.
  useEffect(() => {
    if (pageRole() !== "board") return;
    const onPen = (e: Event) => {
      const d = (e as CustomEvent<{ spec?: string; add?: boolean }>).detail;
      const sk = d?.spec ? parseSketch(d.spec) : null;
      if (!sk?.items.length) {
        if (d && !d.spec) setPen(null);
        return;
      }
      const p = pet.current;
      const body = p?.getBodyRect() ?? null;
      const size = bodySize(p, body);
      setPen((prev) => {
        const items = d?.add && prev ? [...prev.items, ...sk.items].slice(0, 48) : sk.items;
        const rect = d?.add && prev ? prev.rect : penRect(lastJudgement.current, items, size, window.innerWidth, window.innerHeight);
        return { id: d?.add && prev ? prev.id : Date.now(), rect, title: sk.title ?? (d?.add ? prev?.title : undefined), items };
      });
      playCue("chalk");
      reportMask(QUIET_NOTE_MS);
      if (p && !(d?.add)) {
        const rect = penRect(lastJudgement.current, sk.items, size, window.innerWidth, window.innerHeight);
        const to = besidePoint({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, size.width, size.height, window.innerWidth);
        const center = body && body.width > 0 ? { x: body.left + body.width / 2, y: body.top + body.height / 2 } : null;
        if (!center || Math.hypot(to.x - center.x, to.y - center.y) >= STAY_PX) void p.goTo(to.x, to.y);
      }
    };
    window.addEventListener("burrow:pen", onPen);
    return () => window.removeEventListener("burrow:pen", onPen);
  }, [pet]);

  // The pen writes one item at a time.
  useEffect(() => {
    if (!pen) {
      setPenShown(0);
      return;
    }
    const total = pen.items.length + (pen.title ? 1 : 0);
    if (reduced) {
      setPenShown(total);
      return;
    }
    setPenShown((n) => Math.min(n, total));
    const t = window.setInterval(() => setPenShown((n) => (n >= total ? n : n + 1)), PEN_STEP_MS);
    return () => window.clearInterval(t);
  }, [pen, reduced]);

  // The ring goes on its own after a while; a fade first unless motion is reduced.
  useEffect(() => {
    if (!mark) return;
    if (leaving) {
      const t = window.setTimeout(
        () => {
          setMark(null);
          setLeaving(false);
        },
        reduced ? 0 : MARK_OUT_MS,
      );
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setLeaving(true), MARK_TTL_MS);
    return () => window.clearTimeout(t);
  }, [mark, leaving, reduced]);

  if (!mark && !pen) return null;
  const r = mark?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const w = r.width + 2 * MARK_PAD;
  const h = r.height + 2 * MARK_PAD;
  const d = mark ? ringPath(w, h, mark.id) : "";
  let penIndex = 0;
  const penTotal = pen ? pen.items.length + (pen.title ? 1 : 0) : 0;
  const penTextH = pen ? (pen.items.filter((it) => it.kind === "text").length + (pen.title ? 1 : 0)) * PEN_LINE_PX : 0;
  const penShapeH = pen ? Math.max(0, pen.rect.height - penTextH - 8) : 0;
  return (
    <div className="pip-inkcoach" aria-hidden="true">
      {pen && (
        <div key={pen.id} className={`pip-pen${penShown >= penTotal ? " complete" : ""}`} style={{ left: pen.rect.x, top: pen.rect.y, width: pen.rect.width, transform: `rotate(${((pen.id % 5) - 2) * 0.4}deg)` }} role="figure" aria-label="note">
          {pen.title && penIndex++ < penShown && <div className="pip-pen-line pip-pen-title">{pen.title}</div>}
          {pen.items.map((it, i) => (it.kind === "text" ? <div key={`${pen.id}-t${i}`} className="pip-pen-line" style={{ visibility: i + (pen.title ? 1 : 0) < penShown ? "visible" : "hidden" }}>{it.text}</div> : null))}
          {pen.items.some((it) => it.kind === "stroke") && penShapeH > 40 && (
            <div className="pip-pen-canvas" style={{ height: penShapeH }}>
              <svg width={pen.rect.width} height={penShapeH} viewBox={`0 0 ${pen.rect.width} ${penShapeH}`} style={{ overflow: "visible" }}>
                {pen.items.map((it, i) => (it.kind === "stroke" && it.stroke.kind !== "label" && i + (pen.title ? 1 : 0) < penShown ? <PenShape key={`${pen.id}-s${i}`} stroke={it.stroke} w={pen.rect.width} h={penShapeH} /> : null))}
              </svg>
              {pen.items.map((it, i) =>
                it.kind === "stroke" && it.stroke.kind === "label" && i + (pen.title ? 1 : 0) < penShown ? (
                  <span key={`${pen.id}-l${i}`} className="pip-pen-label" style={{ left: `${it.stroke.n[0]}%`, top: `${it.stroke.n[1]}%` }}>
                    {it.stroke.text}
                  </span>
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
      {mark && (
      <svg key={mark.id} className={`pip-inkmark${reduced ? " reduced" : ""}${leaving ? " leaving" : ""}`} style={{ left: r.x - MARK_PAD, top: r.y - MARK_PAD, width: w, height: h, transform: `rotate(${((Math.abs(mark.id) % 7) - 3) * 1.3}deg)` }} viewBox={`0 0 ${w} ${h}`} overflow="visible">
        <path d={d} pathLength={100} className="pip-inkmark-rim" />
        <path d={d} pathLength={100} className="pip-inkmark-ink" />
      </svg>
      )}
    </div>
  );
}
