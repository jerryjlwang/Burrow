// The pixel clock: hand-placed 5 x 7 digits from scene/digits.png (brown ink, one pixel cream rim),
// drawn on a small canvas at a whole-number scale that fits the window.

export interface Digits {
  img: HTMLImageElement;
  height: number;
  glyphs: Record<string, { x: number; w: number }>;
}

const SPACE = 3;

export function loadDigits(): Promise<Digits> {
  return fetch("scene/manifest.json")
    .then((r) => r.json())
    .then(
      (m: { digits: { file: string; height: number; glyphs: Record<string, { x: number; w: number }> } }) =>
        new Promise<Digits>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ img, height: m.digits.height, glyphs: m.digits.glyphs });
          img.onerror = () => reject(new Error("digits failed to load"));
          img.src = `scene/${m.digits.file}`;
        }),
    );
}

/** Whole scale for the big digits: about 90px tall on a 1280 wide window, smaller on narrow ones. */
export function clockScale(width = window.innerWidth): number {
  return Math.max(5, Math.min(13, Math.floor(width / 98)));
}

/** "7:05 AM" style text for the clock, with the hour possibly forced for screenshots. */
export function clockText(now: Date, hour: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${h12}:${mm} ${hour < 12 ? "AM" : "PM"}`;
}

/** Glyph run widths in source pixels for the given text at scale 1, spaces are gaps. */
function measure(text: string, d: Digits): number {
  let w = 0;
  for (const ch of text) w += ch === " " ? SPACE : (d.glyphs[ch]?.w ?? 0);
  return w;
}

export function drawClock(canvas: HTMLCanvasElement, text: string, scale: number, d: Digits): void {
  const [time, suffix = ""] = text.split(" ");
  const small = Math.max(3, Math.round(scale * 0.55));
  const bigW = measure(time, d) * scale;
  const smallW = suffix ? measure(suffix, d) * small : 0;
  const gap = suffix ? SPACE * scale : 0;
  const width = bigW + gap + smallW;
  const height = d.height * scale;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  let x = 0;
  const run = (s: string, sc: number, baseline: number) => {
    for (const ch of s) {
      if (ch === " ") {
        x += SPACE * sc;
        continue;
      }
      const g = d.glyphs[ch];
      if (!g) continue;
      ctx.drawImage(d.img, g.x, 0, g.w, d.height, x, baseline - d.height * sc, g.w * sc, d.height * sc);
      x += g.w * sc;
    }
  };
  run(time, scale, height);
  x += gap;
  run(suffix, small, height);
}
