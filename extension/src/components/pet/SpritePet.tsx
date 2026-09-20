import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CHARACTER, loadCharacter, type CharacterManifest, type LoadedCharacter } from "./manifest";
import { SpritePlayer } from "./player";

/** The pet's footprint in viewport pixels: as wide as the body box, as tall as the cell. */
export interface PetBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PetController {
  readonly manifest: CharacterManifest;
  /** Ask for a manifest state by name. Transitions apply; unknown names fall back to idle. */
  play(state: string): void;
  /** Hole travel: dive here, come up with the body center at viewport (x, y). */
  moveTo(x: number, y: number): Promise<void>;
  /** Sending half of a jump. Resolves once the rabbit is gone. */
  jumpOut(): Promise<void>;
  /** Receiving half: open a hole, wait in it until `ready` settles, then pop out. */
  jumpIn(ready: Promise<unknown>): Promise<void>;
  /** Body box in viewport coordinates, or null before the art loads. */
  getBodyRect(): DOMRect | null;
}

export interface SpritePetProps {
  /** Folder under public/characters. */
  character?: string;
  /** Manifest state name. */
  state: string;
  speaking?: boolean;
  /** 0..1 loudness, picks the mouth frame while speaking. */
  level?: number;
  reducedMotion?: boolean;
  /** Whole-number draw scale. Default 3. */
  scale?: number;
  /** Rough target height in px; picks the nearest whole scale when `scale` is not given. */
  size?: number;
  /**
   * Called with the clamped footprint whenever the pet wants to move (drag, moveTo, resize).
   * The owner positions the pet; without it the pet cannot be dragged.
   */
  onPosition?: (box: PetBox) => void;
  onAnchor?: (getCenter: () => { x: number; y: number }) => void;
  onController?: (controller: PetController | null) => void;
}

interface Geometry {
  cw: number;
  ch: number;
  W: number;
  H: number;
  bodyLeft: number;
  bodyTop: number;
  bodyW: number;
  bodyH: number;
}

const DRAG_THRESHOLD = 4;
const HOLE_BEAT_MS = 650;

function geometry(manifest: CharacterManifest, S: number): Geometry {
  const [cw, ch] = manifest.cell;
  const [l, t, r, b] = manifest.body ?? [0, 0, cw, ch];
  return { cw, ch, W: cw * S, H: ch * S, bodyLeft: l * S, bodyTop: t * S, bodyW: Math.max(1, r - l) * S, bodyH: Math.max(1, b - t) * S };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

export function SpritePet({ character = DEFAULT_CHARACTER, state, speaking = false, level = 0, reducedMotion = false, scale, size, onPosition, onAnchor, onController }: SpritePetProps) {
  const [loaded, setLoaded] = useState<LoadedCharacter | null>(null);
  const [gone, setGone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SpritePlayer | null>(null);
  const drag = useRef<{ px: number; py: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef({ state, speaking, level, reducedMotion });
  latest.current = { state, speaking, level, reducedMotion };

  useEffect(() => {
    let alive = true;
    loadCharacter(character).then(
      (c) => alive && setLoaded(c),
      (e) => console.warn(`[pet] ${String(e)}`),
    );
    return () => {
      alive = false;
    };
  }, [character]);

  const S = useMemo(() => {
    if (scale) return Math.max(1, Math.floor(scale));
    if (size && loaded) return Math.max(1, Math.round(size / loaded.manifest.cell[1]));
    return 3;
  }, [scale, size, loaded]);
  const geo = useMemo(() => (loaded ? geometry(loaded.manifest, S) : null), [loaded, S]);

  // Player and draw loop. One per character load and scale.
  useEffect(() => {
    if (!loaded || !geo) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const player = new SpritePlayer(loaded.manifest, loaded.images);
    playerRef.current = player;
    const p = latest.current;
    player.setReducedMotion(p.reducedMotion);
    player.setSpeaking(p.speaking, p.level);
    player.setState(p.state);
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      player.tick(dt);
      if (player.dirty) {
        player.draw(ctx, S);
        player.dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [loaded, geo, S]);

  useEffect(() => {
    playerRef.current?.setState(state);
  }, [state, loaded]);
  useEffect(() => {
    playerRef.current?.setSpeaking(speaking, level);
  }, [speaking, level, loaded]);
  useEffect(() => {
    playerRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, loaded]);

  const clampBox = useCallback(
    (left: number, top: number): PetBox => {
      const g = geo!;
      return {
        left: clamp(left, 0, window.innerWidth - g.bodyW),
        top: clamp(top, -g.bodyTop, window.innerHeight - (g.bodyTop + g.bodyH)),
        width: g.bodyW,
        height: g.H,
      };
    },
    [geo],
  );

  // Keep the body on screen when the window changes size, and keep the owner's copy of the box fresh.
  useEffect(() => {
    if (!onPosition || !geo) return;
    const onResize = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) onPosition(clampBox(r.left, r.top));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onPosition, geo, clampBox]);

  useEffect(() => {
    onAnchor?.(() => {
      const r = hitRef.current?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth - 60, y: window.innerHeight - 60 };
    });
  }, [onAnchor]);

  useEffect(() => {
    if (!loaded || !geo || !onController) return;
    const seq = loaded.manifest.jump_sequence ?? {};
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const jumpOut = async () => {
      const p = playerRef.current;
      if (!p) return;
      await p.runSequence(seq.sending ?? []);
      p.setHidden(true);
      setGone(true);
    };
    const jumpIn = async (ready: Promise<unknown>) => {
      const p = playerRef.current;
      if (!p) return;
      setGone(false);
      await p.runSequence(seq.receiving ?? [], ready);
    };
    const controller: PetController = {
      manifest: loaded.manifest,
      play: (s) => playerRef.current?.setState(s),
      jumpOut,
      jumpIn,
      moveTo: async (x, y) => {
        await jumpOut();
        onPosition?.(clampBox(x - geo.bodyW / 2, y - geo.bodyTop - geo.bodyH / 2));
        await jumpIn(wait(HOLE_BEAT_MS));
      },
      getBodyRect: () => hitRef.current?.getBoundingClientRect() ?? null,
    };
    onController(controller);
    return () => onController(null);
  }, [loaded, geo, onController, onPosition, clampBox]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onPosition || !geo || e.button !== 0 || playerRef.current?.inSequence) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { px: e.clientX, py: e.clientY, left: r.left, top: r.top, moved: false };
    hitRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setDragging(true);
      playerRef.current?.override("dragged");
    }
    onPosition?.(clampBox(d.left + dx, d.top + dy));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    try {
      hitRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (d.moved) {
      setDragging(false);
      playerRef.current?.override(null);
      suppressClick.current = true;
    }
  };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // "pip-char" stays on the root so existing selectors (e2e smoke test) still find the character.
  if (!geo) return <div ref={rootRef} className="pet pip-char pet-loading" />;

  return (
    <div ref={rootRef} className={`pet pip-char${gone ? " gone" : ""}${dragging ? " dragging" : ""}`} style={{ width: geo.bodyW, height: geo.H }} data-character={character}>
      <canvas ref={canvasRef} className="pet-canvas" width={geo.W} height={geo.H} style={{ left: -geo.bodyLeft, width: geo.W, height: geo.H }} aria-hidden="true" />
      <div
        ref={hitRef}
        className="pet-hit"
        style={{ left: 0, top: geo.bodyTop, width: geo.bodyW, height: geo.bodyH }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={onClick}
      />
    </div>
  );
}
