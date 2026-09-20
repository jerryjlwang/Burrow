import { useEffect, useRef, useState } from "react";
import type { Stroke } from "@shared/sketch";
import type { Rect } from "@shared/types";
import { EMPTY_BUSY } from "@shared/video";
import { store, useStore } from "../content/store";

/**
 * The rabbit's drawing surface: text lines and freeform strokes overlaid directly on the page —
 * white chalk with a dark outline, no box, so the content underneath stays visible and the ink
 * reads on light and dark backgrounds alike. Anchored sketches wrap their 100×100 stroke space
 * onto a page element and track it as it moves; with a `region` they sit inside one part of it
 * (a video's empty space), words and all, so the drawing looks like part of the picture.
 * Unanchored ones float in the corner. `add` sketches extend the drawing and the staged reveal
 * continues instead of restarting. The student can drag it anywhere by its bounding box; the
 * inside of the box stays click-through, so a video underneath still plays and pauses. It goes
 * away only when asked: the ✕, Escape, or the agent's erase — never by itself.
 */
const INK = "#fff";
const OUTLINE = "rgba(0,0,0,.78)";
// A glow, not an offset outline: offsets close up the counters of the pixel font and the words turn to blobs.
const TEXT_SHADOW = "0 0 2px #000, 0 0 4px rgba(0,0,0,.95), 0 0 7px rgba(0,0,0,.8), 0 1px 10px rgba(0,0,0,.55)";
/** How far outside the drawing its grab frame sits, and how thick the grabbable edge is. */
const BOX_PAD = 8;
const EDGE = 14;
/** However far it is dragged, this much of the drawing stays on screen to grab again. */
const KEEP_VISIBLE = 60;

/** A diagram keeps its proportions up to this stretch; past it the space is left unused rather than flattening the drawing. */
const MAX_STRETCH = 1.5;

const textStyle: React.CSSProperties = { whiteSpace: "pre-wrap", color: INK, textShadow: TEXT_SHADOW, fontWeight: 600, fontSize: 17, lineHeight: 1.5 };

interface Size {
  w: number;
  h: number;
}

/**
 * One stroke as SVG, in the canvas's own pixels. Board units are mapped here rather than by a
 * stretched viewBox: that needs vector-effect="non-scaling-stroke", under which Chrome measures
 * dashes in screen pixels and ignores pathLength — the draw-in's dash pattern then shows as gaps.
 */
function StrokeShape({ stroke, size, animate }: { stroke: Stroke; size: Size; animate: boolean }) {
  const unit = Math.min(size.w, size.h) / 100;
  const X = (v: number) => (v * size.w) / 100;
  const Y = (v: number) => (v * size.h) / 100;
  const [a, b, c, d] = stroke.n;
  // Every shape is drawn twice: a wide dark pass, then the chalk on top.
  const passes = [{ stroke: OUTLINE, strokeWidth: 6.5 }, { stroke: INK, strokeWidth: 3 }];
  const common = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, pathLength: 100, style: animate ? { animation: "pip-chalk 500ms ease-out backwards" } : undefined };
  switch (stroke.kind) {
    case "line":
      return <>{passes.map((p, i) => <path key={i} d={`M ${X(a)} ${Y(b)} L ${X(c)} ${Y(d)}`} {...common} {...p} />)}</>;
    case "arrow": {
      // Head drawn as two short flicks at the tip, angled off the shaft.
      const ang = Math.atan2(Y(d) - Y(b), X(c) - X(a));
      const len = Math.max(9, 4 * unit);
      const flick = (off: number) => `M ${X(c)} ${Y(d)} L ${X(c) - len * Math.cos(ang + off)} ${Y(d) - len * Math.sin(ang + off)}`;
      return <>{passes.map((p, i) => <path key={i} d={`M ${X(a)} ${Y(b)} L ${X(c)} ${Y(d)} ${flick(0.5)} ${flick(-0.5)}`} {...common} {...p} />)}</>;
    }
    case "circle":
      return <>{passes.map((p, i) => <circle key={i} cx={X(a)} cy={Y(b)} r={c * unit} {...common} {...p} />)}</>;
    case "rect":
      return <>{passes.map((p, i) => <rect key={i} x={X(a)} y={Y(b)} width={X(c)} height={Y(d)} {...common} {...p} />)}</>;
    case "dot":
      return <circle cx={X(a)} cy={Y(b)} r={Math.max(4, 1.3 * unit)} fill={INK} stroke={OUTLINE} strokeWidth={2} />;
    default:
      return null;
  }
}

/** Tracks an anchor element's viewport rect every frame; null when unanchored or the element is gone. */
function useAnchorRect(anchor: Element | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      if (!anchor.isConnected) {
        setRect(null);
        return;
      }
      const r = anchor.getBoundingClientRect();
      setRect((old) => (old && Math.abs(old.x - r.x) < 0.5 && Math.abs(old.y - r.y) < 0.5 && Math.abs(old.width - r.width) < 0.5 && Math.abs(old.height - r.height) < 0.5 ? old : { x: r.x, y: r.y, width: r.width, height: r.height }));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [anchor]);
  return rect;
}

/** The stroke canvas's size in CSS pixels, so strokes can be laid out in its own coordinates. */
function useSize(): [(el: HTMLDivElement | null) => void, Size | null] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((old) => (old && Math.abs(old.w - r.width) < 0.5 && Math.abs(old.h - r.height) < 0.5 ? old : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

/**
 * Dragging by the box. The offset lives here, keyed to the board id: extending or erasing part of a
 * drawing keeps it where the student put it, a fresh drawing starts back at its anchor.
 */
function useDrag(boardId: string | undefined) {
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const [hot, setHot] = useState(false);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; rect: DOMRect } | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setOffset({ dx: 0, dy: 0 });
    setHot(false);
    drag.current = null;
  }, [boardId]);

  const grab = {
    onPointerEnter: () => setHot(true),
    onPointerLeave: () => {
      if (!drag.current) setHot(false);
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!wrapper.current) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, dx: offset.dx, dy: offset.dy, rect: wrapper.current.getBoundingClientRect() };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d) return;
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      const mx = clamp(e.clientX - d.x, KEEP_VISIBLE - d.rect.right, window.innerWidth - KEEP_VISIBLE - d.rect.left);
      const my = clamp(e.clientY - d.y, KEEP_VISIBLE - d.rect.bottom, window.innerHeight - KEEP_VISIBLE - d.rect.top);
      setOffset({ dx: d.dx + mx, dy: d.dy + my });
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      drag.current = null;
      if (!e.currentTarget.matches(":hover")) setHot(false);
    },
  };
  return { offset, hot, grab, wrapper };
}

/*
 * Class names are pip-sketch*, deliberately not the framed Board's pip-board*: that stylesheet gives
 * its root a frame border, a 27px font and a rise animation (which pins `transform`), and its
 * canvas a forced 1:1 box — all of which break a drawing laid over the page.
 */

/** Chalk drawn over a page element (a video, a problem). Unanchored sketches are the framed Board's. */
export function SketchOverlay() {
  const board = useStore((s) => s.board);
  const reduced = useStore((s) => s.reducedMotion);
  const [revealed, setRevealed] = useState(0);
  // Reveal position survives `add` extensions (same board id): only the new items stage in.
  const prevReveal = useRef({ id: "", count: 0 });

  useEffect(() => {
    if (!board) return;
    const from = prevReveal.current.id === board.id ? Math.min(prevReveal.current.count, board.items.length) : 0;
    prevReveal.current = { id: board.id, count: from };
    if (reduced) {
      setRevealed(board.items.length);
      prevReveal.current.count = board.items.length;
      return;
    }
    setRevealed(Math.max(from, 1));
    prevReveal.current.count = Math.max(from, 1);
    const timer = window.setInterval(() => {
      setRevealed((r) => {
        const next = r >= board.items.length ? r : r + 1;
        prevReveal.current.count = next;
        if (next >= board.items.length) window.clearInterval(timer);
        return next;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [board, reduced]);

  const anchorRect = useAnchorRect(board?.anchor ?? null);
  const [canvasRef, size] = useSize();
  const { offset, hot, grab, wrapper } = useDrag(board?.id);
  if (!board || !board.anchor) return null;

  const shown = board.items.slice(0, revealed);
  const hasStrokeItems = board.items.some((it) => it.kind === "stroke");
  const region = anchorRect ? board.region ?? null : null;
  // Inside a region the whole sketch — words too — lives within that part of the anchor.
  const rect = anchorRect && region ? { x: anchorRect.x + region.x * anchorRect.width, y: anchorRect.y + region.y * anchorRect.height, width: region.w * anchorRect.width, height: region.h * anchorRect.height } : anchorRect;

  // An element wrap maps onto the element exactly (that is the point of it); anywhere else the
  // 100×100 space keeps its shape, so a triangle drawn into a wide strip is still a triangle.
  const canvas = (host: React.CSSProperties, fit: "stretch" | "proportional") => {
    const box = size && fit === "proportional" ? { w: Math.min(size.w, size.h * MAX_STRETCH), h: Math.min(size.h, size.w * MAX_STRETCH) } : size;
    return (
      <div ref={canvasRef} style={{ ...host, pointerEvents: "none" }}>
        {box && box.w > 0 && box.h > 0 && (
          // Strokes in the box's own pixels; labels as HTML at percentage positions, so text stays crisp.
          <div style={{ position: "absolute", left: 0, top: 0, width: box.w, height: box.h }}>
            <svg className="pip-sketch-canvas" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden="true">
              {shown.map((item, i) => (item.kind === "stroke" && item.stroke.kind !== "label" ? <StrokeShape key={`${board.id}-s${i}`} stroke={item.stroke} size={box} animate={!reduced} /> : null))}
            </svg>
            {shown.map((item, i) =>
              item.kind === "stroke" && item.stroke.kind === "label" ? (
                <div key={`${board.id}-l${i}`} className="pip-sketch-label" style={{ position: "absolute", left: `${item.stroke.n[0]}%`, top: `${item.stroke.n[1]}%`, transform: "translateY(-50%)", ...textStyle, fontSize: 15, fontWeight: 700, whiteSpace: "nowrap", animation: reduced ? undefined : "pip-chalk-fade 400ms ease-out both" }}>
                  {item.stroke.text}
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    );
  };

  const textLines = shown.filter((it) => it.kind === "text");
  const textBlock = (textLines.length > 0 || board.title) && (
    <div style={{ pointerEvents: "none" }}>
      {board.title && <div className="pip-sketch-title" style={{ ...textStyle, fontWeight: 700, opacity: 0.9, marginBottom: 2 }}>{board.title}</div>}
      {shown.map((item, i) => (item.kind === "text" ? <div key={`${board.id}-${i}`} className="pip-sketch-line" style={textStyle}>{item.text}</div> : null))}
    </div>
  );

  const close = (
    <button
      type="button"
      aria-label="Close the board"
      onClick={() => store.setState({ board: null })}
      style={{ position: "absolute", top: -10, right: -10, width: 22, height: 22, borderRadius: 11, background: "rgba(0,0,0,.55)", border: "none", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: "22px", padding: 0, pointerEvents: "auto" }}
    >
      ✕
    </button>
  );

  // The grab frame: a dashed box that shows on hover or drag, four thin grabbable edges, and a grip
  // by the ✕ so it can be found. Everything inside the edges stays click-through.
  const handle: React.CSSProperties = { position: "absolute", pointerEvents: "auto", cursor: "move", touchAction: "none" };
  const out = -BOX_PAD - EDGE / 2;
  const dragFrame = (
    <>
      <div className="pip-sketch-box" data-hot={hot ? "true" : "false"} style={{ position: "absolute", inset: -BOX_PAD, border: "1.5px dashed rgba(255,255,255,.95)", boxShadow: "0 0 0 1px rgba(0,0,0,.6), inset 0 0 0 1px rgba(0,0,0,.6)", borderRadius: 8, opacity: hot ? 1 : 0, transition: "opacity 120ms", pointerEvents: "none" }} />
      <div className="pip-sketch-edge" {...grab} style={{ ...handle, left: out, right: out, top: out, height: EDGE }} />
      <div className="pip-sketch-edge" {...grab} style={{ ...handle, left: out, right: out, bottom: out, height: EDGE }} />
      <div className="pip-sketch-edge" {...grab} style={{ ...handle, top: out, bottom: out, left: out, width: EDGE }} />
      <div className="pip-sketch-edge" {...grab} style={{ ...handle, top: out, bottom: out, right: out, width: EDGE }} />
      <div className="pip-sketch-grip" role="button" aria-label="Drag the drawing" title="Drag to move" {...grab} style={{ ...handle, top: -10, right: 18, width: 22, height: 22, borderRadius: 11, background: "rgba(0,0,0,.55)", color: "#fff", fontSize: 13, lineHeight: "22px", textAlign: "center", userSelect: "none" }}>
        ✥
      </div>
    </>
  );

  const frame: React.CSSProperties = { position: "fixed", zIndex: 2147483000, pointerEvents: "none", fontFamily: "inherit", transform: `translate(${offset.dx}px, ${offset.dy}px)` };

  if (rect && region) {
    // Inside the video's empty space: words on top, the diagram filling what is left beneath them.
    return (
      <div ref={wrapper} className="pip-sketch" role="figure" aria-label="drawing" data-placement="video" style={{ ...frame, left: rect.x, top: rect.y, width: rect.width, height: rect.height, display: "flex", flexDirection: "column", gap: 6, padding: 8, boxSizing: "border-box", borderRadius: 10, background: region.busy > EMPTY_BUSY ? "rgba(0,0,0,.5)" : undefined }}>
        {textBlock}
        {hasStrokeItems && canvas({ position: "relative", flex: 1, minHeight: 0 }, "proportional")}
        {dragFrame}
        {close}
      </div>
    );
  }

  if (rect) {
    // Wrapped to a page element: strokes span its rect; words sit just below it.
    return (
      <div ref={wrapper} className="pip-sketch" role="figure" aria-label="drawing" data-placement="element" style={{ ...frame, left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
        {hasStrokeItems && canvas({ position: "absolute", inset: 0 }, "stretch")}
        {textBlock && <div style={{ position: "absolute", left: 0, top: "100%", paddingTop: 8, maxWidth: Math.max(rect.width, 320) }}>{textBlock}</div>}
        {dragFrame}
        {close}
      </div>
    );
  }

  return (
    <div ref={wrapper} className="pip-sketch" role="figure" aria-label="drawing" data-placement="corner" style={{ ...frame, left: 20, bottom: 20, width: 380 }}>
      {textBlock}
      {hasStrokeItems && canvas({ position: "relative", width: "100%", aspectRatio: "1 / 1", marginTop: 6 }, "proportional")}
      {dragFrame}
      {close}
    </div>
  );
}
