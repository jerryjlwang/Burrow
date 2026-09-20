import type { PetController } from "../pet";

/**
 * Shared ground for the rabbit's action set pieces (tabs.ts, hands.ts, video.ts): the event shapes the
 * executor and the video watcher send, the context a piece gets, and small helpers for DOM-driven
 * pixel effects. Every piece is show only: it never touches the page or changes what an action does.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the executor announces before an action ("burrow:act"); `hold` is the piece's promise, waited at most HOLD_MS. */
export interface ActDetail {
  action: string;
  elementId: number | null;
  rect: Rect | null;
  point: { x: number; y: number } | null;
  url: string | null;
  text: string | null;
  direction: "up" | "down" | null;
  hold?: Promise<unknown>;
}

/** What the video watcher announces ("burrow:video"). */
export interface VideoDetail {
  kind: "pause" | "play" | "seek";
  by: "us" | "them";
  rect: Rect | null;
}

export interface PieceContext {
  /** The sprite player, or null before the art loads. */
  pet: PetController | null;
  /** A fixed, full-viewport, pointer-transparent layer inside the companion's shadow root for effects. */
  layer: HTMLElement;
  reduced: boolean;
  /** The rabbit's body box in viewport pixels, or null. */
  petRect: () => DOMRect | null;
}

export type Piece<D> = (detail: D, ctx: PieceContext) => Promise<void> | void;

/** The executor waits for a piece's hold at most this long (mirror of ACT_HOLD_MS in actions/executor.ts). */
export const HOLD_MS = 900;

export const wait = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** Round to the 3px grid the pixel UI sits on. */
export const grid = (n: number): number => Math.round(n / 3) * 3;

/** The rabbit's body box from any node inside the companion's shadow root. */
export function petRectFrom(node: Node): DOMRect | null {
  const root = node.getRootNode();
  const scope: ParentNode = root && "querySelector" in root ? (root as ParentNode) : document;
  return scope.querySelector(".pet-hit")?.getBoundingClientRect() ?? null;
}

/** Add a pixel effect element to the layer. It is removed after `ms`, or when the returned function is called. */
export function spawn(layer: HTMLElement, className: string, style: Partial<CSSStyleDeclaration> = {}, ms = 0): { el: HTMLElement; gone: () => void } {
  const el = document.createElement("div");
  el.className = className;
  Object.assign(el.style, style);
  layer.appendChild(el);
  let timer = 0;
  const gone = () => {
    window.clearTimeout(timer);
    el.remove();
  };
  if (ms > 0) timer = window.setTimeout(gone, ms);
  return { el, gone };
}

/** Where the rabbit should stand to reach a rect: beside it on the left when there is room, else on the right. */
export function standBeside(rect: Rect, pet: DOMRect | null): { x: number; y: number } {
  const w = pet?.width ?? 93;
  const h = pet?.height ?? 159;
  const gap = 12;
  const left = rect.x - gap - w / 2;
  const x = left > w / 2 ? left : Math.min(window.innerWidth - w / 2, rect.x + rect.width + gap + w / 2);
  const y = Math.max(h / 2, Math.min(window.innerHeight - h / 2, rect.y + rect.height / 2));
  return { x, y };
}
