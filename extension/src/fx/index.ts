/**
 * Burrow page effects: a WebGL overlay that adds 3 px scanlines and a faint dither grain to the
 * extension's own pages, and a Bayer dither dissolve on load and before the rabbit escorts a
 * navigation. Built as its own entry (fx.js) and included by the pages with a script tag. It never
 * runs in the content script, and it sits under the companion's host so the rabbit stays crisp.
 *
 * window.burrowFx exposes dissolveIn() and dissolveOut() for pages and tests.
 */
import { Mesh, Program, Renderer, Triangle } from "ogl";

const Z_INDEX = 2147483000;
const BLOCK = 3;
const DISSOLVE_MS = 520;
const CREAM: [number, number, number] = [255 / 255, 248 / 255, 231 / 255];

const vertex = /* glsl */ `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// Ordered dither on 3 px blocks. bayer() is the 4 x 4 matrix written out with parity arithmetic.
const fragment = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uDissolve;
uniform float uScan;
uniform vec3 uCover;
varying vec2 vUv;
float bayer(vec2 p) {
  vec2 q = floor(mod(p, 4.0));
  float x0 = mod(q.x, 2.0);
  float y0 = mod(q.y, 2.0);
  float x1 = floor(q.x / 2.0);
  float y1 = floor(q.y / 2.0);
  return (abs(x0 - y0) * 8.0 + y0 * 4.0 + abs(x1 - y1) * 2.0 + y1) / 16.0;
}
void main() {
  vec2 block = floor(gl_FragCoord.xy / ${BLOCK}.0);
  float threshold = bayer(block);
  float covered = step(threshold + 0.001, uDissolve);
  float row = mod(floor(gl_FragCoord.y), ${BLOCK}.0);
  float scan = row < 1.0 ? uScan : 0.0;
  float grain = (bayer(block + floor(uTime * 2.0)) - 0.5) * 0.028;
  float a = clamp(scan + grain, 0.0, 0.12);
  vec4 base = vec4(0.0, 0.0, 0.0, a);
  vec4 cover = vec4(uCover, 1.0);
  gl_FragColor = mix(base, cover, covered);
}
`;

interface Fx {
  dissolveIn(): Promise<void>;
  dissolveOut(): Promise<void>;
  readonly dissolve: number;
}

declare global {
  interface Window {
    burrowFx?: Fx;
  }
}

function start(): Fx | null {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const canvas = document.createElement("canvas");
  canvas.id = "burrow-fx";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${Z_INDEX};image-rendering:pixelated;`;
  let renderer: Renderer;
  try {
    renderer = new Renderer({ canvas, alpha: true, dpr: 1, antialias: false, premultipliedAlpha: true });
  } catch {
    return null;
  }
  const gl = renderer.gl;
  document.documentElement.appendChild(canvas);
  const program = new Program(gl, {
    vertex,
    fragment,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uDissolve: { value: reduced ? 0 : 1 },
      uScan: { value: 0.045 },
      uCover: { value: CREAM },
    },
  });
  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

  const resize = () => renderer.setSize(window.innerWidth, window.innerHeight);
  resize();
  window.addEventListener("resize", resize);

  // Dissolve target and easing: stepped through the 16 Bayer levels so it reads as pixels, not a fade.
  let dissolve = reduced ? 0 : 1;
  let target = dissolve;
  let from = dissolve;
  let startAt = 0;
  let settle: (() => void) | null = null;
  const animate = (to: number): Promise<void> => {
    if (reduced) {
      dissolve = target = to;
      program.uniforms.uDissolve.value = to;
      return Promise.resolve();
    }
    from = dissolve;
    target = to;
    startAt = performance.now();
    settle?.();
    return new Promise((resolve) => {
      settle = resolve;
    });
  };

  const loop = (t: number) => {
    if (dissolve !== target) {
      const k = Math.min(1, (t - startAt) / DISSOLVE_MS);
      dissolve = from + (target - from) * k;
      dissolve = Math.round(dissolve * 16) / 16;
      if (k >= 1) {
        dissolve = target;
        settle?.();
        settle = null;
      }
      program.uniforms.uDissolve.value = dissolve;
    }
    program.uniforms.uTime.value = t / 1000;
    renderer.render({ scene: mesh });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const fx: Fx = {
    dissolveIn: () => animate(0),
    dissolveOut: () => animate(1),
    get dissolve() {
      return dissolve;
    },
  };
  // Uncover the page once it has painted, and cover it again when the rabbit escorts a navigation.
  requestAnimationFrame(() => void fx.dissolveIn());
  window.addEventListener("burrow:leave", () => void fx.dissolveOut());
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) void fx.dissolveIn();
  });
  return fx;
}

const fx = start();
if (fx) window.burrowFx = fx;
