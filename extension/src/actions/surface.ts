import type { KeyChord } from "@shared/keys";
import { HOST_ID } from "../page-understanding/extract";
import type { ElementRegistry } from "../page-understanding/registry";

/**
 * Acting on the visible surface by point rather than by listed element, with page (DOM) events.
 * This is the default path: no debugger session, no browser warning bar, and it reaches almost
 * every widget. What it cannot do — CSS :hover, default key behaviour (Tab moving focus, arrows
 * moving a caret), user-activation-gated calls, setPointerCapture widgets, isTrusted checks — is
 * what the executor escalates to real input for.
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

// Escape is the student's "stop everything". A key the rabbit presses for the page must not
// trip that on itself, and with real input isTrusted cannot tell the two apart.
let ownKeyUntil = 0;
export const noteOwnKey = (): void => {
  ownKeyUntil = Date.now() + 400;
};
export const isOwnKey = (): boolean => Date.now() < ownKeyUntil;

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

/** Native drag-and-drop by events: one DataTransfer carried from dragstart to drop, which is all a drop target reads. */
function syntheticNativeDrag(source: Element, from: Point, to: Point): void {
  const dataTransfer = new DataTransfer();
  const drag = (el: Element, type: string, p: Point) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, dataTransfer }));
  drag(source, "dragstart", from);
  drag(source, "drag", from);
  const target = elementAtPoint(to) ?? document.body;
  drag(target, "dragenter", to);
  drag(target, "dragover", to);
  drag(target, "drop", to);
  drag(source, "dragend", to);
}

export function syntheticDrag(from: Point, to: Point): void {
  const source = elementAtPoint(from) ?? document.body;
  const draggable = source.closest('[draggable="true"]');
  if (draggable && typeof DragEvent === "function" && typeof DataTransfer === "function") return syntheticNativeDrag(draggable, from, to);
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
