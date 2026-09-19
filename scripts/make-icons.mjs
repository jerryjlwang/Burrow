// Generates the extension icons (a small friendly blob) as PNGs without any native deps.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "extension", "public", "icons");
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function render(size) {
  const ss = 4; // supersampling
  const W = size * ss;
  const px = Buffer.alloc(size * size * 4);
  const acc = new Float64Array(size * size * 4);
  const cx = W / 2, cy = W / 2 + W * 0.02, r = W * 0.44;
  const eyeR = W * 0.075;
  const eyeY = cy - W * 0.05;
  const eyeDX = W * 0.17;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let R = 0, G = 0, B = 0, A = 0;
      if (d <= r) {
        // Soft vertical gradient: coral-peach to warm violet.
        const t = clamp01((y - (cy - r)) / (2 * r));
        R = lerp(255, 124, t); G = lerp(154, 92, t); B = lerp(120, 255, t);
        // Subtle highlight top-left
        const hx = cx - r * 0.35, hy = cy - r * 0.4;
        const hd = Math.sqrt((x - hx) ** 2 + (y - hy) ** 2) / (r * 0.7);
        const hl = clamp01(1 - hd) * 0.35;
        R = lerp(R, 255, hl); G = lerp(G, 255, hl); B = lerp(B, 255, hl);
        A = 255;
        // Eyes
        for (const s of [-1, 1]) {
          const ex = cx + s * eyeDX;
          const ed = Math.sqrt((x - ex) ** 2 + (y - eyeY) ** 2);
          if (ed <= eyeR) { R = 30; G = 26; B = 46; }
          const gd = Math.sqrt((x - (ex - eyeR * 0.35)) ** 2 + (y - (eyeY - eyeR * 0.35)) ** 2);
          if (gd <= eyeR * 0.3) { R = 255; G = 255; B = 255; }
        }
        // Smile
        const sy = cy + W * 0.12;
        const sdx = (x - cx) / (W * 0.16);
        if (Math.abs(sdx) <= 1) {
          const curve = sy + (1 - sdx * sdx) * W * 0.05;
          if (Math.abs(y - curve) < W * 0.018) { R = 30; G = 26; B = 46; }
        }
      }
      const ix = Math.floor(x / ss), iy = Math.floor(y / ss);
      const i = (iy * size + ix) * 4;
      acc[i] += R * (A / 255); acc[i + 1] += G * (A / 255); acc[i + 2] += B * (A / 255); acc[i + 3] += A;
    }
  }
  const n = ss * ss;
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / n;
    const cov = a / 255 || 1;
    px[i * 4] = Math.round(acc[i * 4] / n / cov);
    px[i * 4 + 1] = Math.round(acc[i * 4 + 1] / n / cov);
    px[i * 4 + 2] = Math.round(acc[i * 4 + 2] / n / cov);
    px[i * 4 + 3] = Math.round(a);
  }
  return px;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), encodePNG(size, size, render(size)));
}
console.log("icons written to extension/public/icons");
