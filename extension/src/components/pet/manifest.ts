/**
 * Character manifest types and loader. See docs/frontend/CHARACTER_MANIFEST.md.
 * The player reads only the manifest, so a new character is a new folder under
 * extension/public/characters/<name>/.
 */

export type OverlayName = "blink" | "mouth";

export interface StateDef {
  file: string;
  frames: number;
  fps: number;
  loop: boolean;
  notes?: string;
  /** Per frame vertical offset in pixels for overlays. Missing means 0. */
  head_dy?: number[];
  /** Overlay strips that may be drawn on top of this state. Missing means none. */
  overlays?: OverlayName[];
  /** Non-looping state stays on its last frame until the state changes. */
  hold?: boolean;
  /** Non-looping state to play before this one starts. */
  enter?: string;
  /** Non-looping state to play when leaving this one. */
  exit?: string;
  /** Idle only: one-shot flourishes picked at random between idle loops. */
  variants?: { state: string; weight: number }[];
  /** Per frame sideways travel in source pixels while this state plays as a travel loop. */
  move?: number[];
}

export interface JumpStep {
  state: string;
  reverse?: boolean;
  /** Keep looping this state until the handoff confirms. */
  loop?: boolean;
}

export interface CharacterManifest {
  character: string;
  cell: [number, number];
  anchor?: string;
  /** left, top, right, bottom of the character in idle frame 0; right and bottom exclusive. */
  body?: [number, number, number, number];
  jump_sequence?: { sending?: JumpStep[]; receiving?: JumpStep[] };
  idle_variant_gap?: [number, number];
  /** Seconds of quiet idle before the character wanders a few hops on its own. */
  wander_gap?: [number, number];
  /** Hops per wander. */
  wander_hops?: [number, number];
  states: Record<string, StateDef>;
}

export interface LoadedCharacter {
  name: string;
  manifest: CharacterManifest;
  images: Record<string, HTMLImageElement>;
}

export const DEFAULT_CHARACTER = "rabbit";

/** Extension URL for a file under public/. Falls back to a relative path outside an extension. */
export function assetUrl(path: string): string {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) return chrome.runtime.getURL(path);
  } catch {
    /* not an extension context */
  }
  return path;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

const cache = new Map<string, Promise<LoadedCharacter>>();

/** Fetches a character's manifest and every strip it lists. Cached per character name. */
export function loadCharacter(name: string = DEFAULT_CHARACTER): Promise<LoadedCharacter> {
  const hit = cache.get(name);
  if (hit) return hit;
  const p = (async () => {
    const base = `characters/${name}/`;
    const res = await fetch(assetUrl(`${base}manifest.json`));
    if (!res.ok) throw new Error(`Manifest for ${name} failed: ${res.status}`);
    const manifest = (await res.json()) as CharacterManifest;
    if (!manifest.states || !manifest.states.idle) throw new Error(`Manifest for ${name} has no idle state`);
    const entries = await Promise.all(
      Object.entries(manifest.states).map(async ([state, def]) => [state, await loadImage(assetUrl(base + def.file))] as const),
    );
    const images: Record<string, HTMLImageElement> = {};
    for (const [state, img] of entries) images[state] = img;
    if (!manifest.cell) {
      const idle = images.idle;
      manifest.cell = [Math.floor(idle.width / Math.max(1, manifest.states.idle.frames)), idle.height];
    }
    return { name, manifest, images };
  })();
  cache.set(name, p);
  p.catch(() => cache.delete(name));
  return p;
}
