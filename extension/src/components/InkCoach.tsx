import { useEffect, useRef, useState, type RefObject } from "react";
import type { InkBox } from "@shared/ink";
import { parseSketch } from "@shared/sketch";
import type { Rect } from "@shared/types";
import type { InkStageDetail } from "../shared/messages";
import { store, useStore } from "../content/store";
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
const RING_DRAW_MS = 550;
const NOTE_RISE_MS = 600;
/** He does not bother moving for a target this close to where he already stands. */
const STAY_PX = 40;

const toRect = (b: InkBox): Rect => ({ x: b.x * window.innerWidth, y: b.y * window.innerHeight, width: b.w * window.innerWidth, height: b.h * window.innerHeight });

/**
 * A hand-drawn ring for a w x h box: an ellipse that wobbles a little, drifts outward as it goes
 * round, and runs a bit past a full turn so the end overlaps the start the way a pen does.
 */
export function ringPath(w: number, h: number, seed = 1): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = Math.max(6, w / 2 - 3);
  const ry = Math.max(6, h / 2 - 3);
  const start = 2.6;
  const sweep = Math.PI * 2 * 1.12;
  const n = 56;
  const phase = ((Math.abs(seed) % 997) / 997) * Math.PI * 2;
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

export function InkCoach({ pet }: { pet: RefObject<PetController | null> }) {
  const reduced = useStore((s) => s.reducedMotion);
  const [mark, setMark] = useState<Mark | null>(null);
  const [leaving, setLeaving] = useState(false);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

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
      const center = body ? { x: body.left + body.width / 2, y: body.top + body.height / 2 } : null;
      if (d.phase === "note" && j.note.length) {
        e.preventDefault();
        void (async () => {
          const spot = j.space ? toRect(j.space) : j.box ? toRect(j.box) : null;
          if (p && body && center && spot) {
            // He stands in the lower right of the empty space; the chalkboard rises beside him, on the side with room.
            const x = spot.x + spot.width - body.width / 2 - 24;
            const y = spot.y + spot.height - body.height / 2;
            if (Math.hypot(x - center.x, y - center.y) >= STAY_PX) await p.goTo(x, y);
          }
          const sk = parseSketch(j.note.join("\n"));
          if (sk.items.length) store.setState({ board: { id: `ink-${Date.now()}`, title: sk.title, items: sk.items, anchor: null }, planView: null });
          window.setTimeout(d.done, reducedRef.current ? 0 : NOTE_RISE_MS);
        })();
        return;
      }
      if (d.phase === "nudge" && (j.mark || j.box)) {
        e.preventDefault();
        void (async () => {
          const line = toRect(j.box ?? j.mark!);
          const part = toRect(j.mark ?? j.box!);
          if (p && body && center) {
            const to = besidePoint(line, body.width, body.height, window.innerWidth);
            if (Math.hypot(to.x - center.x, to.y - center.y) >= STAY_PX) await p.goTo(to.x, to.y);
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
      <svg key={mark.id} className={`pip-inkmark${reduced ? " reduced" : ""}${leaving ? " leaving" : ""}`} style={{ left: r.x - MARK_PAD, top: r.y - MARK_PAD, width: w, height: h }} viewBox={`0 0 ${w} ${h}`} overflow="visible">
        <path d={d} pathLength={100} className="pip-inkmark-rim" />
        <path d={d} pathLength={100} className="pip-inkmark-ink" />
      </svg>
    </div>
  );
}
