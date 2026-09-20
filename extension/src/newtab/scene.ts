// The meadow behind the new tab page. Pieces come from extension/public/scene (tools/sprites/scene_px.py).
// Everything is composed at source size on an offscreen canvas and drawn 3x with smoothing off, so every
// position is a whole source pixel by construction. Layers move by whole pixels on timers; nothing tweens.

export type Tod = "morning" | "day" | "evening" | "night";

interface Piece {
  x: number;
  y: number;
  w: number;
  h: number;
  frames: number;
}

interface SceneManifest {
  atlas: { width: number; height: number; files: Record<Tod, string> };
  pieces: Record<string, Piece>;
  palettes: Record<Tod, Record<string, [number, number, number]>>;
}

export interface SceneOptions {
  /** Hour of the day to draw for, read on every tick so the light can change while the tab sits open. */
  hour: () => number;
  reducedMotion: boolean;
  /** Draw rain (a rare treat, a forced flag for screenshots). */
  rain: boolean;
  /** Called with the ground color so the page can paint the sliver a resize might leave. */
  onPalette?: (tod: Tod, ground: string) => void;
}

export const SCALE = 3;

/** Which palette an hour gets. */
export function todFor(hour: number): Tod {
  if (hour >= 5 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** mulberry32: a tiny seeded generator so the meadow lays out the same way every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  piece: string;
  x: number;
  y: number;
  flip?: boolean;
  /** 0..1, staggers two frame swaps. */
  phase: number;
  /** Sways between two frames when the piece has them. */
  sways?: boolean;
}

interface Cloud {
  piece: string;
  x0: number;
  y: number;
  /** ms per one pixel step. */
  period: number;
  flip: boolean;
}

interface Firefly {
  x: number;
  y: number;
  phase: number;
}

interface Layout {
  sw: number;
  sh: number;
  groundTop: number;
  hedgeTop: number;
  horizon: number;
  farBottom: number;
  nearBottom: number;
  clouds: Cloud[];
  stars: Item[];
  back: Item[];
  ground: Item[];
  fireflies: Firefly[];
  butterflies: Firefly[];
  rain: { x: number; y0: number }[];
  mound: { x: number; y: number };
  path: { from: number; to: number; y: number };
}

function layout(sw: number, sh: number): Layout {
  const groundTop = sh - 83;
  const hedgeTop = groundTop - 11;
  const nearBottom = hedgeTop + 5;
  const farBottom = hedgeTop - 2;
  const horizon = farBottom - 6;
  const r = rng(7);
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];

  const clouds: Cloud[] = [
    { piece: "cloud_b", x0: Math.round(sw * 0.12), y: Math.round(horizon * 0.2), period: 1000, flip: false },
    { piece: "cloud_a", x0: Math.round(sw * 0.58), y: Math.round(horizon * 0.42), period: 1400, flip: false },
    { piece: "cloud_c", x0: Math.round(sw * 0.82), y: Math.round(horizon * 0.58), period: 750, flip: true },
    { piece: "cloud_c", x0: Math.round(sw * 0.36), y: Math.round(horizon * 0.1), period: 1900, flip: false },
  ];

  const stars: Item[] = [];
  for (let i = 0; i < 52; i++) {
    stars.push({ piece: r() < 0.3 ? "star_a" : "star_b", x: Math.floor(r() * sw), y: Math.floor(r() * (horizon - 10)), phase: r() });
  }

  // Back row: fences at the edges, a signpost, bushes between. The right corner stays his.
  const back: Item[] = [
    { piece: "fence", x: 4, y: groundTop + 7 - 15, phase: 0 },
    { piece: "signpost", x: 44, y: groundTop + 6 - 27, phase: 0 },
    { piece: "bush_c", x: Math.round(sw * 0.2), y: groundTop + 6 - 11, phase: 0 },
    { piece: "bush_a", x: Math.round(sw * 0.36), y: groundTop + 5 - 10, phase: 0 },
    { piece: "bush_b", x: Math.round(sw * 0.48), y: groundTop + 6 - 8, phase: 0 },
    { piece: "bush_d", x: Math.round(sw * 0.6), y: groundTop + 5 - 8, phase: 0 },
    { piece: "bush_a", x: Math.round(sw * 0.7), y: groundTop + 6 - 10, phase: 0, flip: true },
  ];
  if (sw > 300) {
    back.push({ piece: "fence", x: sw - 162, y: groundTop + 7 - 15, phase: 0 });
    back.push({ piece: "bush_c", x: sw - 126, y: groundTop + 6 - 11, phase: 0, flip: true });
  }

  // Middle and front rows: a jittered grid of tufts, flowers and mushrooms.
  const ground: Item[] = [];
  const rows = [groundTop + 16, groundTop + 31, groundTop + 46, groundTop + 61];
  for (const baseY of rows) {
    for (let x = 6; x < sw - 100; x += 20) {
      if (r() > 0.72) continue;
      const jx = x + Math.floor(r() * 11) - 5;
      const jy = baseY + Math.floor(r() * 9) - 4;
      const roll = r();
      const piece = roll < 0.52 ? pick(["tuft_a", "tuft_b", "tuft_c"]) : roll < 0.82 ? pick(["flower_r", "flower_y", "flower_w", "flower_s"]) : roll < 0.9 ? pick(["mush_a", "mush_b", "mush_c"]) : "flower_s";
      ground.push({ piece, x: jx, y: jy, phase: r(), flip: r() < 0.5, sways: piece.startsWith("tuft") });
    }
  }
  for (let x = 12; x < sw - 100; x += 34) {
    if (r() > 0.6) continue;
    ground.push({ piece: "tuft_c", x: x + Math.floor(r() * 9), y: sh - 12 + Math.floor(r() * 5), phase: r(), flip: r() < 0.5, sways: true });
  }
  ground.push({ piece: "bush_b", x: Math.round(sw * 0.1), y: groundTop + 34, phase: 0 });
  ground.push({ piece: "mush_c", x: sw - 120, y: sh - 22, phase: 0 });
  ground.push({ piece: "flower_y", x: sw - 104, y: sh - 26, phase: 0 });

  const fireflies: Firefly[] = [];
  for (let i = 0; i < 10; i++) {
    fireflies.push({ x: 10 + Math.floor(r() * Math.max(1, sw - 110)), y: groundTop - 30 + Math.floor(r() * 90), phase: Math.floor(r() * 8) });
  }
  const butterflies: Firefly[] = [];
  for (let i = 0; i < 4; i++) {
    butterflies.push({ x: 20 + Math.floor(r() * Math.max(1, sw - 130)), y: groundTop + 4 + Math.floor(r() * 50), phase: Math.floor(r() * 4) });
  }
  const rain: { x: number; y0: number }[] = [];
  for (let i = 0; i < 90; i++) rain.push({ x: Math.floor(r() * sw), y0: Math.floor(r() * sh) });

  return {
    sw, sh, groundTop, hedgeTop, horizon, farBottom, nearBottom, clouds, stars, back, ground, fireflies, butterflies, rain,
    mound: { x: sw - 81, y: sh - 3 - 29 },
    path: { from: Math.round(sw * 0.3), to: sw - 26, y: sh - 9 },
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

export function startScene(canvas: HTMLCanvasElement, opts: SceneOptions): () => void {
  let stopped = false;
  let man: SceneManifest | null = null;
  let img: HTMLImageElement | null = null;
  let tod: Tod | null = null;
  let loadingTod: Tod | null = null;
  let lay: Layout | null = null;
  let mx = 0;
  let my = 0;
  const src = document.createElement("canvas");
  const sctx = src.getContext("2d")!;
  const t0 = performance.now();
  // Firefly walks are whole steps taken on ticks, so they keep their own state.
  let fireflyTick = -1;
  let flies: Firefly[] = [];
  let butterflyTick = -1;
  let butters: Firefly[] = [];

  const rgb = (key: string): string => {
    const c = man!.palettes[tod!][key] ?? [255, 0, 255];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };

  const piece = (name: string): Piece => man!.pieces[name];

  const draw = (name: string, x: number, y: number, frame = 0, flip = false): void => {
    const p = piece(name);
    if (!p || !img) return;
    const sx = p.x + (frame % p.frames) * p.w;
    if (!flip) {
      sctx.drawImage(img, sx, p.y, p.w, p.h, x, y, p.w, p.h);
      return;
    }
    sctx.save();
    sctx.translate(x + p.w, y);
    sctx.scale(-1, 1);
    sctx.drawImage(img, sx, p.y, p.w, p.h, 0, 0, p.w, p.h);
    sctx.restore();
  };

  /** Repeat a tile across the width, mirroring every other copy when asked, starting at a whole offset. */
  const tileAcross = (name: string, y: number, offset: number, mirrorAlternate: boolean): void => {
    const p = piece(name);
    if (!p || !lay) return;
    const start = ((offset % p.w) + p.w) % p.w - p.w;
    let i = 0;
    for (let x = start - p.w; x < lay.sw + p.w; x += p.w, i++) draw(name, x, y, 0, mirrorAlternate && i % 2 === 1);
  };

  const ensureSize = (): boolean => {
    const sw = Math.ceil(window.innerWidth / SCALE);
    const sh = Math.ceil(window.innerHeight / SCALE);
    if (lay && lay.sw === sw && lay.sh === sh) return false;
    lay = layout(sw, sh);
    flies = lay.fireflies.map((f) => ({ ...f }));
    butters = lay.butterflies.map((f) => ({ ...f }));
    src.width = sw;
    src.height = sh;
    canvas.width = sw * SCALE;
    canvas.height = sh * SCALE;
    canvas.style.width = `${sw * SCALE}px`;
    canvas.style.height = `${sh * SCALE}px`;
    return true;
  };

  const render = (): void => {
    if (!man || !img || !tod || !lay) return;
    const L = lay;
    const t = opts.reducedMotion ? 0 : performance.now() - t0;
    const motion = !opts.reducedMotion;
    const px = motion ? Math.round(mx * 2) : 0;
    const py = motion ? Math.round(my * 1) : 0;
    sctx.imageSmoothingEnabled = false;

    // Sky: six flat bands, the lowest one glows behind the hills.
    const edges = [0, 0.3, 0.5, 0.65, 0.78, 0.9].map((f) => Math.round(L.horizon * f));
    edges.push(L.groundTop + 2);
    for (let i = 0; i < 6; i++) {
      sctx.fillStyle = rgb(`K${i + 1}`);
      sctx.fillRect(0, edges[i], L.sw, edges[i + 1] - edges[i]);
    }
    // One checkered row at each seam, whole pixels of the band above, so the steps read softer.
    for (let i = 1; i < 6; i++) {
      const y = edges[i];
      sctx.fillStyle = rgb(`K${i}`);
      for (let x = y & 1; x < L.sw; x += 2) sctx.fillRect(x, y, 1, 1);
    }

    // Sun, moon and stars.
    if (tod === "night" || tod === "evening") {
      const limit = tod === "night" ? L.horizon - 10 : L.horizon - 80;
      for (const s of L.stars) {
        if (s.y >= limit) continue;
        const tick = Math.floor(t / 500 + s.phase * 4);
        const frame = s.piece === "star_a" ? tick % 2 : tick % 5 === 0 ? 1 : 0;
        draw(s.piece, s.x + px, s.y + py, frame);
      }
    }
    if (tod === "night") draw("moon", Math.round(L.sw * 0.84) + px, 20 + py);
    if (tod === "morning") draw("sun", Math.round(L.sw * 0.16) + px, L.horizon - 34 + py);
    if (tod === "day") draw("sun", Math.round(L.sw * 0.84) + px, 22 + py);
    if (tod === "evening") draw("sun", Math.round(L.sw * 0.76) + px, L.horizon - 8 + py);

    // Clouds drift right by one pixel per period and wrap.
    for (const c of L.clouds) {
      const p = piece(c.piece);
      const span = L.sw + p.w;
      const x = ((c.x0 + Math.floor(t / c.period)) % span) - p.w;
      draw(c.piece, x + px, c.y + py, 0, c.flip);
    }
    // A small flock crosses leftward by day, then rests off screen for a while before coming round again.
    if (tod !== "night" && motion) {
      const span = L.sw + 260;
      const lead = L.sw + 40 - (Math.floor(t / 110) % span);
      const flap = Math.floor(t / 220);
      const y0 = Math.round(L.horizon * 0.38);
      for (const [dx, dy, ph] of [[0, 0, 0], [10, 4, 1], [20, 8, 0], [12, -5, 1]] as [number, number, number][]) {
        draw("bird", lead + dx + px, y0 + dy + py, (flap + ph) % 2);
      }
    }

    // Hills, hedge, ground: nearer layers slide against the mouse a little more.
    tileAcross("hills_far", L.farBottom - piece("hills_far").h, Math.round(-mx * 2) * (motion ? 1 : 0), true);
    tileAcross("hills_near", L.nearBottom - piece("hills_near").h, 40 + Math.round(-mx * 3) * (motion ? 1 : 0), true);
    tileAcross("hedge", L.hedgeTop, Math.round(-mx * 4) * (motion ? 1 : 0), false);
    sctx.fillStyle = rgb("g");
    sctx.fillRect(0, L.groundTop + 2, L.sw, L.sh - L.groundTop - 2);
    const g = piece("ground");
    for (let y = L.groundTop + 2; y < L.sh; y += g.h) for (let x = 0; x < L.sw; x += g.w) draw("ground", x, y);
    // The path wanders by a pixel per tile so it does not read as a plank.
    const pa = piece("path");
    const wobble = [0, 1, 1, 0, -1, -1];
    for (let x = L.path.from, i = 0; x < L.path.to; x += pa.w, i++) {
      const w = Math.min(pa.w, L.path.to - x);
      sctx.drawImage(img, pa.x, pa.y, w, pa.h, x, L.path.y + wobble[i % wobble.length], w, pa.h);
    }
    draw("mound", L.mound.x, L.mound.y);
    draw("smoke", L.mound.x + 39, L.mound.y - 5, Math.floor(t / 700) % 2);
    for (const it of L.back) draw(it.piece, it.x, it.y, 0, it.flip);
    const sorted = L.ground.slice().sort((a, b) => a.y + piece(a.piece).h - (b.y + piece(b.piece).h));
    for (const it of sorted) {
      const frame = it.sways ? Math.floor(t / 650 + it.phase) % 2 : 0;
      draw(it.piece, it.x, it.y, frame, it.flip);
    }

    // Butterflies by day: quick whole pixel flutters over the flowers.
    if ((tod === "day" || tod === "morning") && butters.length) {
      const tick = Math.floor(t / 130);
      if (motion && tick !== butterflyTick) {
        butterflyTick = tick;
        const r = rng(tick * 977 + 3);
        for (const b of butters) {
          if (r() < 0.7) b.x = Math.min(L.sw - 104, Math.max(6, b.x + (r() < 0.5 ? -1 : 1)));
          if (r() < 0.6) b.y = Math.min(L.sh - 20, Math.max(L.groundTop - 6, b.y + (r() < 0.5 ? -1 : 1)));
        }
      }
      butters.forEach((b, i) => draw(i % 2 ? "butterfly_w" : "butterfly_y", b.x, b.y, (tick + b.phase) % 2));
    }
    // Fireflies at night: whole pixel wanders, blinking on a phase.
    if (tod === "night" && flies.length) {
      const tick = Math.floor(t / 250);
      if (motion && tick !== fireflyTick) {
        fireflyTick = tick;
        const r = rng(tick * 131 + 17);
        for (const f of flies) {
          if (r() < 0.6) f.x = Math.min(L.sw - 100, Math.max(6, f.x + (r() < 0.5 ? -1 : 1)));
          if (r() < 0.5) f.y = Math.min(L.sh - 10, Math.max(L.groundTop - 34, f.y + (r() < 0.5 ? -1 : 1)));
        }
      }
      for (const f of flies) draw("firefly", f.x, f.y, (tick + f.phase) % 9 < 5 ? 0 : 1);
    }
    if (opts.rain && motion) {
      const tick = Math.floor(t / 45);
      for (const d of L.rain) draw("rain", d.x, ((d.y0 + tick * 3) % (L.sh + 3)) - 3);
    }

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, L.sw, L.sh, 0, 0, L.sw * SCALE, L.sh * SCALE);
    canvas.dataset.ready = "1";
  };

  const setTod = async (next: Tod): Promise<void> => {
    if (!man || next === loadingTod) return;
    loadingTod = next;
    const image = await loadImage(`scene/${man.atlas.files[next]}`);
    if (stopped || loadingTod !== next) return;
    img = image;
    tod = next;
    canvas.dataset.tod = next;
    const gc = man.palettes[next].g;
    opts.onPalette?.(next, `rgb(${gc[0]},${gc[1]},${gc[2]})`);
    render();
  };

  const onMouse = (e: MouseEvent): void => {
    mx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    my = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
  };
  const onResize = (): void => {
    if (ensureSize()) render();
  };

  let timer = 0;
  const tick = (): void => {
    if (stopped) return;
    const want = todFor(opts.hour());
    if (want !== tod && want !== loadingTod) void setTod(want);
    if (document.hidden) return;
    render();
  };

  void fetch("scene/manifest.json")
    .then((r) => r.json())
    .then(async (m: SceneManifest) => {
      if (stopped) return;
      man = m;
      ensureSize();
      await setTod(todFor(opts.hour()));
      window.addEventListener("resize", onResize);
      if (!opts.reducedMotion) {
        window.addEventListener("mousemove", onMouse);
        timer = window.setInterval(tick, 50);
      } else {
        timer = window.setInterval(tick, 30_000);
      }
    })
    .catch((e) => console.warn("[newtab] scene failed to load", e));

  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("mousemove", onMouse);
  };
}
