import { useEffect, useRef, useState, type RefObject } from "react";
import type { InkBox, InkJudgement } from "@shared/ink";
import { parseSketch } from "@shared/sketch";
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
const MARK_TTL_MS = 20_000;
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

/** Tells the watcher where the companion's UI is right now, and optionally to look away for a while. */
function reportMask(quietMs?: number): void {
  const viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  sendToBackground({ type: "tablet.mask", rects: ownUiRects(), viewport, ...(quietMs ? { quietMs } : {}) }, 2000).catch(() => undefined);
}
/** The parts of the companion's UI the watcher must not read as ink. */
const MASK_SELECTORS = [".pip-dock", ".pip-board", ".pip-inkmark", ".pip-sketch", ".pip-plan"];

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
      if (d.phase === "clear") {
        setMark((m) => (m ? { ...m, id: -Math.abs(m.id) } : null));
        setLeaving(true);
        if (j.solved) store.setState((s) => (s.board?.id.startsWith("ink-") ? { board: null } : {}));
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
          const spot = j.space ? toRect(j.space) : j.box ? toRect(j.box) : null;
          if (p && spot) {
            // He stands in the lower right of the empty space; the chalkboard rises beside him, on the side with room.
            const x = spot.x + spot.width - size.width / 2 - 24;
            const y = spot.y + spot.height - size.height / 2;
            if (!center || Math.hypot(x - center.x, y - center.y) >= STAY_PX) await p.goTo(x, y);
          }
          const sk = parseSketch(j.note.join("\n"));
          if (sk.items.length) store.setState({ board: { id: `ink-${Date.now()}`, title: sk.title, items: sk.items, anchor: null }, planView: null });
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

  if (!mark) return null;
  const r = mark.rect;
  const w = r.width + 2 * MARK_PAD;
  const h = r.height + 2 * MARK_PAD;
  const d = ringPath(w, h, mark.id);
  return (
    <div className="pip-inkcoach" aria-hidden="true">
      <svg key={mark.id} className={`pip-inkmark${reduced ? " reduced" : ""}${leaving ? " leaving" : ""}`} style={{ left: r.x - MARK_PAD, top: r.y - MARK_PAD, width: w, height: h, transform: `rotate(${((Math.abs(mark.id) % 7) - 3) * 1.3}deg)` }} viewBox={`0 0 ${w} ${h}`} overflow="visible">
        <path d={d} pathLength={100} className="pip-inkmark-rim" />
        <path d={d} pathLength={100} className="pip-inkmark-ink" />
      </svg>
    </div>
  );
}
