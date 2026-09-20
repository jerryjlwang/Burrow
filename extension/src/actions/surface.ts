import type { KeyChord } from "@shared/keys";
import { HOST_ID } from "../page-understanding/extract";
import type { ElementRegistry } from "../page-understanding/registry";

/**
 * Helpers for acting on the visible surface by point rather than by listed element, plus the
 * untrusted DOM-event fallbacks used when trusted input (the background's debugger session)
 * is unavailable. The fallbacks reach ordinary listeners but not :hover, native drag, or
 * isTrusted checks — callers say so in their result.
 */

export interface Point {
  x: number;
  y: number;
}

/** The innermost element at a viewport point, looking through open shadow roots. */
export function elementAtPoint(p: Point): Element | null {
  if (typeof document.elementFromPoint !== "function") return null;
  let el = document.elementFromPoint(p.x, p.y);
  while (el?.shadowRoot && el.id !== HOST_ID) {
    const inner = el.shadowRoot.elementFromPoint(p.x, p.y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

export function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el && el !== document.body && el !== document.documentElement ? el : null;
}

export const isOwnUi = (el: Element | null): boolean => !!el && (el.id === HOST_ID || !!el.closest(`#${HOST_ID}`));

/** The listed element a point falls on, so policy (confirmations, sensitive fields) judges a coordinate click like any other. */
export function registeredIdAt(registry: ElementRegistry, p: Point): number | null {
  for (let el = elementAtPoint(p); el; el = el.parentElement) {
    if (registry.has(el)) return registry.idFor(el);
  }
  return null;
}

/** Short human description of what a point landed on, for the action result the model reads. */
export function describeElement(el: Element | null): string {
  if (!el) return "the page";
  const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const tag = el.tagName.toLowerCase();
  return label ? `${tag} "${label}"` : tag;
}

function fire(el: Element, type: string, p: Point, extra: MouseEventInit = {}): void {
  const init: MouseEventInit = { bubbles: !/enter$|leave$/.test(type), cancelable: true, composed: true, clientX: p.x, clientY: p.y, ...extra };
  const usePointer = type.startsWith("pointer") && typeof PointerEvent === "function";
  el.dispatchEvent(usePointer ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
}

export function syntheticHover(el: Element, p: Point): void {
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) fire(el, type, p);
}

export function syntheticContextMenu(el: Element, p: Point): void {
  fire(el, "pointerdown", p, { button: 2, buttons: 2 });
  fire(el, "mousedown", p, { button: 2, buttons: 2 });
  fire(el, "pointerup", p, { button: 2 });
  fire(el, "mouseup", p, { button: 2 });
  fire(el, "contextmenu", p, { button: 2 });
}

export function syntheticDoubleClick(el: Element, p: Point): void {
  fire(el, "dblclick", p, { detail: 2 });
}

export function syntheticDrag(from: Point, to: Point): void {
  const source = elementAtPoint(from) ?? document.body;
  fire(source, "pointerdown", from, { buttons: 1 });
  fire(source, "mousedown", from, { buttons: 1 });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    const over = elementAtPoint(p) ?? source;
    fire(over, "pointermove", p, { buttons: 1 });
    fire(over, "mousemove", p, { buttons: 1 });
  }
  const target = elementAtPoint(to) ?? source;
  fire(target, "pointerup", to);
  fire(target, "mouseup", to);
}

export function syntheticKey(target: Element, c: KeyChord): void {
  const init: KeyboardEventInit = { key: c.key, code: c.code, keyCode: c.keyCode, which: c.keyCode, altKey: c.alt, ctrlKey: c.ctrl, metaKey: c.meta, shiftKey: c.shift, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (c.text) target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** Scrolls the nearest scrollable ancestor of a point; returns whether anything moved. */
export function syntheticWheel(p: Point, deltaY: number): boolean {
  for (let el = elementAtPoint(p); el; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (el !== document.documentElement && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
    const before = el.scrollTop;
    el.scrollBy({ top: deltaY });
    if (el.scrollTop !== before) return true;
  }
  const before = window.scrollY;
  window.scrollBy({ top: deltaY });
  return window.scrollY !== before;
}
