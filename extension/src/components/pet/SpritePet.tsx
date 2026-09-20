import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CHARACTER, loadCharacter, type CharacterManifest, type LoadedCharacter } from "./manifest";
import { SpritePlayer } from "./player";
import { FLIGHT, chooseTravel, planHops, planWander, releaseVelocity, stepFlight, stepHop, wanderAllowed, wanderTimerRuns, type FlightBounds, type FlightState } from "./travel";

/** The pet's footprint in viewport pixels: as wide as the body box, as tall as the cell. */
export interface PetBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PetController {
  readonly manifest: CharacterManifest;
  /** Current whole-number draw scale. */
  readonly scale: number;
  /** Ask for a manifest state by name. Transitions apply; unknown names fall back to idle. */
  play(state: string): void;
  /** Hole travel: dive here, come up with the body center at viewport (x, y). */
  moveTo(x: number, y: number): Promise<void>;
  /** Hop along the current row until the body center reaches x. Whole hops, the last one clamped. */
  hopTo(x: number): Promise<void>;
  /** Hop for short trips on this row, otherwise travel through the hole. */
  goTo(x: number, y: number): Promise<void>;
  /** Sending half of a jump. Resolves once the rabbit is gone. */
  jumpOut(): Promise<void>;
  /** Receiving half: open a hole, wait in it until `ready` settles, then pop out. */
  jumpIn(ready: Promise<unknown>): Promise<void>;
  /** Throw him with a velocity in px/s. Resolves on landing. No flight under reduced motion. */
  fling(vx: number, vy: number): Promise<void>;
  /** Change the draw scale (2 to 6) through the hole, keeping the feet where they are. */
  resize(scale: number): Promise<void>;
  /** Wander now if quiet and allowed, ignoring the timer. Returns whether he went. */
  wanderNow(): boolean;
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
  /** Nothing is going on. The wander timer only runs while quiet. */
  quiet?: boolean;
  /**
   * Called with the clamped footprint whenever the pet wants to move (drag, hops, flight, resize).
   * The owner positions the pet; without it the pet cannot move at all.
   */
  onPosition?: (box: PetBox) => void;
  onAnchor?: (getCenter: () => { x: number; y: number }) => void;
  onController?: (controller: PetController | null) => void;
  /** Called with the strip name each time a different state starts showing. */
  onShown?: (state: string) => void;
  /** Start hidden, for a page he is about to pop out of a hole on. Only read when the art first loads. */
  startHidden?: boolean;
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

/** What the pet is doing on its own; exposed as data-phase for tests. */
type Phase = "" | "hop" | "fly" | "land";

interface Travel {
  direction: -1 | 1;
  left: number;
  top: number;
  targetLeft: number;
  hops: number;
  wander: boolean;
  cancel: boolean;
  resolve: () => void;
}

interface Flight {
  state: FlightState;
  bounds: FlightBounds;
  resolve: () => void;
}

interface PointerSample {
  t: number;
  x: number;
  y: number;
}

const DRAG_THRESHOLD = 4;
const HOLE_BEAT_MS = 650;
/** The resting line: the cell's bottom edge sits this far above the viewport bottom (matches .pip-dock). */
const DOCK_EDGE = 18;
const WANDER_MARGIN = 40;
const MIN_SCALE = 2;
const MAX_SCALE = 6;
/** Contract state names used for movement. Missing ones degrade gracefully. */
const TRAVEL_STATE = "hop";
/** Calm ending for a hop trip; falls back to the throw landing when a character lacks it. */
const SETTLE_STATE = "settle";
const LAND_STATE = "land";
const DRAG_STATE = "dragged";

function geometry(manifest: CharacterManifest, S: number): Geometry {
  const [cw, ch] = manifest.cell;
  const [l, t, r, b] = manifest.body ?? [0, 0, cw, ch];
  return { cw, ch, W: cw * S, H: ch * S, bodyLeft: l * S, bodyTop: t * S, bodyW: Math.max(1, r - l) * S, bodyH: Math.max(1, b - t) * S };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

/** Whole-pixel footprint with the body kept inside the viewport. */
function clampFor(g: Geometry, left: number, top: number): PetBox {
  return {
    left: Math.round(clamp(left, 0, window.innerWidth - g.bodyW)),
    top: Math.round(clamp(top, 0, window.innerHeight - (g.bodyTop + g.bodyH))),
    width: g.bodyW,
    height: g.H,
  };
}

function hopLength(manifest: CharacterManifest, S: number): number {
  const move = manifest.states[TRAVEL_STATE]?.move ?? [];
  return move.reduce((sum, v) => sum + v, 0) * S;
}

function drawGap([min, max]: [number, number]): number {
  return min + Math.random() * Math.max(0, max - min);
}

export function SpritePet({ character = DEFAULT_CHARACTER, state, speaking = false, level = 0, reducedMotion = false, scale, size, quiet = false, onPosition, onAnchor, onController, onShown, startHidden = false }: SpritePetProps) {
  const [loaded, setLoaded] = useState<LoadedCharacter | null>(null);
  const [gone, setGone] = useState(false);
  /** The strip showing right now, exposed as data-strip for tests and page effects. */
  const [strip, setStrip] = useState("");
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("");
  const [scaleOverride, setScaleOverride] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<SpritePlayer | null>(null);
  const geoRef = useRef<Geometry | null>(null);
  const drag = useRef<{ px: number; py: number; left: number; top: number; moved: boolean; samples: PointerSample[] } | null>(null);
  const suppressClick = useRef(false);
  const travelRef = useRef<Travel | null>(null);
  const flightRef = useRef<Flight | null>(null);
  const wanderRef = useRef({ timer: -1, lastAt: -Infinity });
  const goneRef = useRef(false);
  const startHiddenRef = useRef(false);
  const playerWaiters = useRef<((p: SpritePlayer) => void)[]>([]);
  const frameRef = useRef<(p: SpritePlayer, dt: number) => void>(() => undefined);
  const latest = useRef({ state, speaking, level, reducedMotion, quiet, onShown, startHidden });
  latest.current = { state, speaking, level, reducedMotion, quiet, onShown, startHidden };
  const firstPlayer = useRef(true);
  const lastShown = useRef("");
  goneRef.current = gone;

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
    if (scaleOverride) return scaleOverride;
    if (scale) return Math.max(1, Math.floor(scale));
    if (size && loaded) return Math.max(1, Math.round(size / loaded.manifest.cell[1]));
    return 3;
  }, [scaleOverride, scale, size, loaded]);
  const geo = useMemo(() => (loaded ? geometry(loaded.manifest, S) : null), [loaded, S]);
  geoRef.current = geo;

  /** Stop a hop or a flight right away and let its caller continue. */
  const cancelMotion = useCallback(() => {
    const tr = travelRef.current;
    const fl = flightRef.current;
    travelRef.current = null;
    flightRef.current = null;
    if (!tr && !fl) return;
    void playerRef.current?.stopTravel();
    setPhase("");
    tr?.resolve();
    fl?.resolve();
  }, []);

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
    if (startHiddenRef.current || (firstPlayer.current && latest.current.startHidden)) {
      startHiddenRef.current = false;
      player.setHidden(true);
      // Down the hole until a jump brings him out: nothing of his dock shows meanwhile.
      setGone(true);
    }
    firstPlayer.current = false;
    if (wanderRef.current.timer < 0 && loaded.manifest.wander_gap) wanderRef.current.timer = drawGap(loaded.manifest.wander_gap);
    const waiters = playerWaiters.current;
    playerWaiters.current = [];
    for (const w of waiters) w(player);
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      player.tick(dt);
      frameRef.current(player, dt);
      if (player.current !== lastShown.current) {
        lastShown.current = player.current;
        setStrip(player.current);
        latest.current.onShown?.(player.current);
      }
      if (player.dirty) {
        player.draw(ctx, S);
        player.dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      cancelMotion();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [loaded, geo, S, cancelMotion]);

  useEffect(() => {
    playerRef.current?.setState(state);
    // A state change cancels a wander in progress; he finishes the hop he is in.
    const tr = travelRef.current;
    if (tr?.wander) tr.cancel = true;
  }, [state, loaded]);
  useEffect(() => {
    playerRef.current?.setSpeaking(speaking, level);
  }, [speaking, level, loaded]);
  useEffect(() => {
    playerRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, loaded]);

  const clampBox = useCallback((left: number, top: number): PetBox => clampFor(geoRef.current!, left, top), []);

  // Report the starting footprint once the art is measured, so the owner can size the stack above
  // the pet from the first frame, not only after a drag.
  useEffect(() => {
    if (!onPosition || !geo) return;
    const r = rootRef.current?.getBoundingClientRect();
    if (r && r.width > 0) onPosition(clampBox(r.left, r.top));
  }, [onPosition, geo, clampBox]);

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

  /* ---------- hops ---------- */

  const startHop = useCallback(
    (p: SpritePlayer, t: Omit<Travel, "cancel" | "resolve">): Promise<void> =>
      new Promise<void>((resolve) => {
        if (!p.travel(t.direction, TRAVEL_STATE)) {
          resolve();
          return;
        }
        travelRef.current = { ...t, cancel: false, resolve };
        setPhase("hop");
      }),
    [],
  );

  const hopTo = useCallback(
    (x: number): Promise<void> => {
      const p = playerRef.current;
      const g = geoRef.current;
      const root = rootRef.current;
      if (!p || !g || !root || !onPosition || p.inSequence) return Promise.resolve();
      cancelMotion();
      const r = root.getBoundingClientRect();
      const left = Math.round(r.left);
      const top = Math.round(r.top);
      const targetCenter = clamp(x, g.bodyW / 2, window.innerWidth - g.bodyW / 2);
      const len = hopLength(p.manifest, S);
      const plan = planHops(left + g.bodyW / 2, targetCenter, len);
      const targetLeft = Math.round(left + plan.distance);
      if (len <= 0 || !p.has(TRAVEL_STATE)) {
        onPosition(clampBox(targetLeft, top));
        return Promise.resolve();
      }
      return startHop(p, { direction: plan.direction, left, top, targetLeft, hops: plan.hops, wander: false });
    },
    [onPosition, S, cancelMotion, clampBox, startHop],
  );

  /* ---------- wander ---------- */

  const startWander = useCallback(
    (p: SpritePlayer): boolean => {
      const g = geoRef.current;
      const root = rootRef.current;
      if (!g || !root || !onPosition) return false;
      const r = root.getBoundingClientRect();
      const plan = planWander(Math.round(r.left), g.bodyW, window.innerWidth, hopLength(p.manifest, S), p.manifest.wander_hops ?? [2, 3], Math.random, WANDER_MARGIN);
      if (!plan) return false;
      wanderRef.current.lastAt = performance.now();
      void startHop(p, { direction: plan.direction, left: Math.round(r.left), top: Math.round(r.top), targetLeft: plan.targetLeft, hops: plan.hops, wander: true });
      return true;
    },
    [onPosition, S, startHop],
  );

  const wanderGate = useCallback((p: SpritePlayer) => {
    const g = geoRef.current;
    const r = rootRef.current?.getBoundingClientRect();
    const l = latest.current;
    const onScreen = !!g && !!r && r.left >= 0 && r.top >= 0 && r.left + g.bodyW <= window.innerWidth && r.top + g.bodyTop + g.bodyH <= window.innerHeight;
    return {
      quiet: l.quiet,
      reducedMotion: l.reducedMotion,
      inSequence: p.inSequence,
      busy: !!drag.current || goneRef.current || p.isHidden || !!travelRef.current || !!flightRef.current,
      onScreen,
      timer: wanderRef.current.timer,
      sinceLastMs: performance.now() - wanderRef.current.lastAt,
      minGapS: p.manifest.wander_gap?.[0] ?? Infinity,
    };
  }, []);

  /* ---------- per frame: hops, flight, wander timer ---------- */

  useEffect(() => {
    frameRef.current = (p, dt) => {
      const g = geoRef.current;
      if (!g) return;
      const tr = travelRef.current;
      if (tr) {
        const moved = p.takeTravel() * S;
        if (moved !== 0) {
          tr.left = stepHop(tr.left, moved, tr.targetLeft, tr.direction);
          onPosition?.(clampBox(tr.left, tr.top));
        }
        if (tr.cancel || p.cycle >= tr.hops) {
          travelRef.current = null;
          if (tr.cancel) {
            void p.stopTravel();
            setPhase("");
            tr.resolve();
          } else {
            setPhase("land");
            void p.stopTravel(p.has(SETTLE_STATE) ? SETTLE_STATE : LAND_STATE).then(() => {
              setPhase("");
              tr.resolve();
            });
          }
        }
        return;
      }
      const fl = flightRef.current;
      if (fl) {
        const r = stepFlight(fl.state, dt, fl.bounds);
        fl.state = r.state;
        onPosition?.({ left: Math.round(r.state.x), top: Math.round(r.state.y), width: g.bodyW, height: g.H });
        if (r.landed) {
          flightRef.current = null;
          setPhase("land");
          void p.stopTravel(LAND_STATE).then(() => {
            setPhase("");
            fl.resolve();
          });
        }
        return;
      }
      const gap = p.manifest.wander_gap;
      if (!gap || !onPosition) return;
      const w = wanderRef.current;
      const gate = wanderGate(p);
      if (!wanderTimerRuns(gate)) return;
      w.timer -= dt;
      if (w.timer > 0) return;
      w.timer = drawGap(gap);
      if (wanderAllowed({ ...gate, timer: 0 })) startWander(p);
    };
  }, [S, onPosition, clampBox, wanderGate, startWander]);

  /* ---------- flight ---------- */

  const startFlight = useCallback(
    (p: SpritePlayer, vx: number, vy: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const g = geoRef.current;
        const root = rootRef.current;
        if (!g || !root || !onPosition) {
          resolve();
          return;
        }
        const r = root.getBoundingClientRect();
        const bounds: FlightBounds = { minX: 0, maxX: window.innerWidth - g.bodyW, minY: 0, floorY: window.innerHeight - DOCK_EDGE - g.H };
        p.override(DRAG_STATE);
        flightRef.current = { state: { x: r.left, y: Math.min(r.top, bounds.floorY), vx, vy, t: 0 }, bounds, resolve };
        setPhase("fly");
      }),
    [onPosition],
  );

  /* ---------- controller ---------- */

  useEffect(() => {
    if (!loaded || !geo || !onController) return;
    const seq = loaded.manifest.jump_sequence ?? {};
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const jumpOut = async () => {
      const p = playerRef.current;
      if (!p) return;
      cancelMotion();
      await p.runSequence(seq.sending ?? []);
      p.setHidden(true);
      setGone(true);
    };
    const jumpIn = async (ready: Promise<unknown>) => {
      const p = playerRef.current;
      if (!p) return;
      cancelMotion();
      await p.runSequence(seq.receiving ?? [], ready);
      // Out of the hole and standing: only now is he here (his dock shows, he may wander).
      setGone(false);
    };
    const moveTo = async (x: number, y: number) => {
      await jumpOut();
      onPosition?.(clampBox(x - geo.bodyW / 2, y - geo.bodyTop - geo.bodyH / 2));
      await jumpIn(wait(HOLE_BEAT_MS));
    };
    const controller: PetController = {
      manifest: loaded.manifest,
      scale: S,
      play: (s) => playerRef.current?.setState(s),
      jumpOut,
      jumpIn,
      moveTo,
      hopTo,
      goTo: (x, y) => {
        const body = hitRef.current?.getBoundingClientRect();
        if (!body) return Promise.resolve();
        const dx = x - (body.left + body.width / 2);
        const dy = y - (body.top + body.height / 2);
        return chooseTravel(dx, dy) === "hop" ? hopTo(x) : moveTo(x, y);
      },
      fling: (vx, vy) => {
        const p = playerRef.current;
        if (!p || p.inSequence || latest.current.reducedMotion || !onPosition) return Promise.resolve();
        cancelMotion();
        return startFlight(p, vx, vy);
      },
      resize: async (n) => {
        const s = Math.round(clamp(n, MIN_SCALE, MAX_SCALE));
        if (s === S || !Number.isFinite(s)) return;
        const root = rootRef.current;
        if (!playerRef.current || !onPosition || !root) {
          setScaleOverride(s);
          return;
        }
        await jumpOut();
        // The feet are the cell's bottom center; keep that point fixed across the change.
        const r = root.getBoundingClientRect();
        const feetX = r.left + geo.bodyW / 2;
        const feetY = r.top + geo.H;
        const ng = geometry(loaded.manifest, s);
        startHiddenRef.current = true;
        const ready = new Promise<SpritePlayer>((res) => playerWaiters.current.push(res));
        setScaleOverride(s);
        await ready;
        onPosition(clampFor(ng, feetX - ng.bodyW / 2, feetY - ng.H));
        await jumpIn(wait(HOLE_BEAT_MS));
      },
      wanderNow: () => {
        const p = playerRef.current;
        if (!p) return false;
        const gate = wanderGate(p);
        if (!wanderTimerRuns(gate)) return false;
        return startWander(p);
      },
      getBodyRect: () => hitRef.current?.getBoundingClientRect() ?? null,
    };
    onController(controller);
    return () => onController(null);
  }, [loaded, geo, S, onController, onPosition, clampBox, cancelMotion, hopTo, startFlight, startWander, wanderGate]);

  /* ---------- dragging and throwing ---------- */

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = playerRef.current;
    if (!onPosition || !geo || e.button !== 0 || !p || p.inSequence) return;
    cancelMotion();
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { px: e.clientX, py: e.clientY, left: r.left, top: r.top, moved: false, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
    hitRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    d.samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (d.samples.length > 2 && now - d.samples[0].t > 200) d.samples.shift();
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setDragging(true);
      playerRef.current?.override(DRAG_STATE);
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
    if (!d.moved) return;
    setDragging(false);
    suppressClick.current = true;
    const p = playerRef.current;
    const v = releaseVelocity(d.samples, performance.now());
    if (p && !latest.current.reducedMotion && v.speed > FLIGHT.throwSpeed) void startFlight(p, v.vx, v.vy);
    else p?.override(null);
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
    <div
      ref={rootRef}
      className={`pet pip-char${gone ? " gone" : ""}${dragging ? " dragging" : ""}`}
      style={{ width: geo.bodyW, height: geo.H }}
      data-character={character}
      data-scale={S}
      data-phase={phase}
      data-strip={strip}
    >
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
