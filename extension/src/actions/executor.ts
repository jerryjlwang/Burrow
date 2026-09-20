import type { AgentDecision } from "@shared/actions";
import type { ActionResult, PageSummary } from "@shared/types";
import type { StepPlan } from "@shared/plan";
import type { InputOp, PendingLoop } from "../shared/messages";
import { parseKeyChord } from "@shared/keys";
import { normalizeText } from "@shared/text";
import { ElementRegistry } from "../page-understanding/registry";
import { isSensitiveField, HOST_ID } from "../page-understanding/extract";
import { OverlayController } from "./overlay";
import { lineLocator, quoteLocator, type RectLocator } from "./locate";
import { deepActiveElement, describeElement, elementAtPoint, isOwnUi, noteOwnKey, syntheticContextMenu, syntheticDoubleClick, syntheticDrag, syntheticHover, syntheticKey, syntheticWheel, type Point } from "./surface";
import { log } from "../shared/logger";

const logger = log("action");

export interface ExecutorDeps {
  registry: ElementRegistry;
  overlay: OverlayController;
  /** Re-extracts the page model right now. */
  rescan: () => PageSummary;
  /** Resolves when the DOM/URL changed or the timeout elapsed. */
  waitForChange: (timeoutMs: number) => Promise<{ changed: boolean; urlChanged: boolean }>;
  navigate: (url: string) => Promise<void>;
  /** `resume` hands the running loop to the new tab so the chain continues on the page it opened. */
  openTab: (url: string, resume?: PendingLoop) => Promise<void>;
  switchTab: (tabId: number) => Promise<void>;
  goBack: () => Promise<void>;
  /** Server-side vetted lookup (no user cookies); returns pre-formatted result lines. */
  lookup: (query: string, prefer?: string) => Promise<string>;
  /** Server-side learning plan for a topic the student wants to learn. */
  makePlan: (topic: string) => Promise<StepPlan | null>;
  /** Open the plan map; false when there is no plan of any kind to show. */
  showPlan: () => boolean;
  /** Overlay a drawing on the screen (newline-separated text lines and draw commands). `add` extends the current one; elementId/quote wrap it to a page region. */
  sketch: (spec: string, opts?: { add?: boolean; elementId?: number | null; quote?: string | null }) => void;
  /** Erase from the drawing on screen: "all" or item numbers. null when nothing is drawn. */
  eraseSketch: (spec: string) => { erased: number; left: number } | null;
  /** Real mouse/keyboard input via the background's debugger session. An escalation, never the first resort. */
  input: (ops: InputOp[]) => Promise<{ ok: boolean; error?: string }>;
  /** Whether the student has switched real input on; off by default, because attaching shows Chrome's debugging bar. */
  trustedInputEnabled: () => boolean;
  /** Called right before an action that may unload the page. */
  beforeMaybeNavigate?: () => Promise<void> | void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isInputLike(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

function isContentEditable(el: Element): boolean {
  if ((el as HTMLElement).isContentEditable === true) return true;
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}

function isEditable(el: Element): boolean {
  if (isInputLike(el)) return !(el as HTMLInputElement).readOnly && !(el as HTMLInputElement).disabled;
  return isContentEditable(el);
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function coveredBy(el: Element): Element | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const { x, y } = center(el);
  const top = document.elementFromPoint(x, y);
  if (!top || top === el || el.contains(top) || top.contains(el)) return null;
  // Our own overlay never blocks (pointer-events none), but be safe.
  if (top.closest("#pip-companion-host")) return null;
  return top;
}

export function dispatchClickSequence(el: Element, at?: Point): void {
  const { x, y } = at ?? center(el);
  const view = el.ownerDocument.defaultView ?? undefined;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 } as const;
  const make = <T extends Event>(ctor: new (type: string, init: Record<string, unknown>) => T, type: string, init: Record<string, unknown>): T => {
    try {
      return new ctor(type, { ...init, view });
    } catch {
      return new ctor(type, init);
    }
  };
  const pointer = (type: string, extra: Record<string, unknown> = {}) =>
    el.dispatchEvent(
      typeof PointerEvent === "function"
        ? make(PointerEvent as unknown as new (type: string, init: Record<string, unknown>) => Event, type, { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra })
        : make(MouseEvent as unknown as new (type: string, init: Record<string, unknown>) => Event, type, { ...base, ...extra }),
    );
  const mouse = (type: string, extra: Record<string, unknown> = {}) => el.dispatchEvent(make(MouseEvent as unknown as new (type: string, init: Record<string, unknown>) => Event, type, { ...base, ...extra }));
  pointer("pointerover");
  mouse("mouseover");
  pointer("pointermove");
  mouse("mousemove");
  pointer("pointerdown", { buttons: 1 });
  mouse("mousedown", { buttons: 1 });
  try {
    (el as HTMLElement).focus?.({ preventScroll: true });
  } catch {
    /* ignore */
  }
  pointer("pointerup");
  mouse("mouseup");
  // el.click() reports the click at (0,0); a canvas or map reads where it landed, so an aimed click is dispatched with its point.
  if (!at && typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
  else mouse("click");
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Types into inputs, textareas and contenteditable elements in a way React/Vue/Angular controlled inputs accept. */
export function typeInto(el: Element, text: string, opts: { clear?: boolean } = {}): string {
  const clear = opts.clear ?? true;
  (el as HTMLElement).focus?.({ preventScroll: true });
  if (isInputLike(el)) {
    const before = el.value;
    const expected = clear ? text : before + text;
    let ok = false;
    try {
      if (clear) el.select();
      else el.setSelectionRange?.(el.value.length, el.value.length);
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (!ok || el.value !== expected) {
      setNativeValue(el, expected);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data: text }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  }
  if (isContentEditable(el)) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (!ok) {
      if (clear) el.textContent = text;
      else el.textContent = (el.textContent ?? "") + text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return el.textContent ?? "";
  }
  throw new Error("element is not editable");
}

function clearElement(el: Element): void {
  (el as HTMLElement).focus?.({ preventScroll: true });
  if (isInputLike(el)) {
    let ok = false;
    try {
      el.select();
      ok = document.execCommand("delete");
    } catch {
      ok = false;
    }
    if (!ok || el.value !== "") {
      setNativeValue(el, "");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (isContentEditable(el)) {
    el.textContent = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }
}

function findScrollableRoot(): Element | null {
  const doc = document.scrollingElement ?? document.documentElement;
  if (doc.scrollHeight > window.innerHeight + 10) return doc;
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll("div,main,section,article")) {
    const st = getComputedStyle(el);
    if (!/(auto|scroll)/.test(st.overflowY)) continue;
    if (el.scrollHeight <= el.clientHeight + 10) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

export async function executeAction(decision: AgentDecision, deps: ExecutorDeps): Promise<ActionResult> {
  const { registry, overlay } = deps;
  const reduced = prefersReducedMotion();
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  const getEl = (): { el: Element } | { error: ActionResult } => {
    const el = decision.elementId != null ? registry.get(decision.elementId) : null;
    if (!el) return { error: { ok: false, message: "That element isn't on the page anymore—let me look again.", elementFound: false } };
    return { el };
  };
  /** Where a pointer action lands: a listed element's centre (brought into view), or a raw viewport point. */
  const resolvePoint = async (id: number | null, x: number | null, y: number | null): Promise<{ point: Point; el: Element | null } | { error: ActionResult }> => {
    if (id != null) {
      const el = registry.get(id);
      if (!el) return { error: { ok: false, message: "That element isn't on the page anymore—let me look again.", elementFound: false } };
      await overlay.scrollIntoViewIfNeeded(el);
      return { point: center(el), el };
    }
    const point = { x: x!, y: y! };
    if (point.x > window.innerWidth || point.y > window.innerHeight) {
      return { error: { ok: false, message: `(${point.x}, ${point.y}) is outside the visible page, which is ${window.innerWidth}x${window.innerHeight}. Scroll it into view first.`, elementFound: false } };
    }
    const el = elementAtPoint(point);
    if (isOwnUi(el)) return { error: { ok: false, message: "That point is on me, not the page.", elementFound: true } };
    return { point, el };
  };
  const clickElement = async (): Promise<ActionResult> => {
    const r = getEl();
    if ("error" in r) return r.error;
    const el = r.el;
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") {
      overlay.highlight(decision.elementId!, { durationMs: 3000 });
      return { ok: false, message: "That control is disabled right now.", elementFound: true };
    }
    await overlay.scrollIntoViewIfNeeded(el);
    let blocker = coveredBy(el);
    if (blocker) {
      window.scrollBy({ top: -120, behavior: "auto" });
      await sleep(80);
      blocker = coveredBy(el);
    }
    if (blocker) {
      const desc = (blocker.getAttribute("aria-label") || blocker.textContent || blocker.tagName).trim().slice(0, 40);
      return { ok: false, message: `Something is covering it (${desc})—maybe a dialog needs closing first.`, elementFound: true };
    }
    overlay.highlight(decision.elementId!, { durationMs: 1600, kind: "acting" });
    await sleep(reduced ? 30 : 260);
    const urlBefore = location.href;
    const errorsBefore = new Set(deps.rescan().errors);
    await deps.beforeMaybeNavigate?.();
    dispatchClickSequence(el);
    const change = await deps.waitForChange(1400);
    const after = deps.rescan();
    const newErrors = after.errors.filter((e) => !errorsBefore.has(e));
    const urlChanged = change.urlChanged || location.href !== urlBefore;
    return {
      ok: true,
      message: urlChanged ? "clicked; page navigated" : change.changed ? "clicked; page updated" : "clicked; no visible change",
      changed: change.changed || urlChanged,
      urlChanged,
      newErrors,
      elementFound: true,
    };
  };
  // Page events come first: they need no debugger session and reach almost every widget. Real
  // input is an escalation the model asks for with `trusted`, and only if the student allows it.
  const realInputOn = deps.trustedInputEnabled();
  const sendReal = async (ops: InputOp[]): Promise<boolean> => realInputOn && (await deps.input(ops)).ok;
  const inputNote = (real: boolean, changed: boolean): string => {
    if (real) return " (real input)";
    if (decision.trusted && !realInputOn) return "; real mouse and keyboard input is switched off in my settings, so I used page events";
    if (changed) return "";
    return realInputOn ? "; if that did not take, repeat it with trusted:true to use the real mouse and keyboard" : "; if that did not take, this page needs real input, which is switched off in my settings";
  };
  const markPoint = (p: Point, durationMs = 1600) => overlay.highlight(registry.idFor(document.body), { durationMs, kind: "acting", locator: () => ({ x: p.x - 14, y: p.y - 14, width: 28, height: 28 }) });

  try {
    switch (decision.action) {
      case "observe":
      case "speak":
      case "explain":
      case "ask_user":
      case "ask_confirmation":
      case "finish":
        return { ok: true, message: `${decision.action} handled by loop` };

      case "wait": {
        await sleep(decision.amount ?? 800);
        return { ok: true, message: `waited ${decision.amount ?? 800}ms` };
      }

      case "highlight":
      case "point_to": {
        // Sub-element anchors: a line of a field's working, or a verbatim quote. Quotes resolve
        // within the target element when given, else anywhere on the page; an unresolvable quote
        // fails honestly instead of pointing at nothing.
        let el: Element | null = decision.elementId != null ? registry.get(decision.elementId) : null;
        let locator: RectLocator | undefined;
        if (decision.line != null && el) {
          locator = lineLocator(el, decision.line) ?? undefined;
          if (!locator) return { ok: false, message: `that field has no line ${decision.line} to point at`, elementFound: true };
        } else if (decision.quote) {
          const root = el ?? document.body;
          locator = quoteLocator(root, decision.quote, HOST_ID) ?? (el ? undefined : quoteLocator(document.body, decision.quote, HOST_ID) ?? undefined);
          if (!locator && !el) return { ok: false, message: `I couldn't find "${decision.quote.slice(0, 60)}" on the page`, elementFound: false };
        }
        if (!el && !locator && decision.x != null && decision.y != null) {
          // A spot the page has no name for: a place on a graph, a handle, a region of an image.
          // Held in page coordinates so the marker stays on the spot if the page scrolls.
          const page = { x: decision.x + window.scrollX, y: decision.y + window.scrollY };
          locator = () => ({ x: page.x - window.scrollX - 18, y: page.y - window.scrollY - 18, width: 36, height: 36 });
        }
        if (!el && locator) {
          // Quote- or point-only targeting: anchor the overlay to the body; the locator supplies the rect.
          el = document.body;
        }
        if (!el) return { ok: false, message: "That element isn't on the page anymore—let me look again.", elementFound: false };
        const id = decision.elementId ?? registry.idFor(el);
        // Bring an off-screen sub-target into view (element targets are scrolled by the overlay itself).
        const sub = locator?.();
        if (sub && (sub.y < 8 || sub.y + sub.height > window.innerHeight - 8)) {
          window.scrollBy({ top: sub.y + sub.height / 2 - window.innerHeight / 2, behavior });
          await sleep(reduced ? 60 : 420);
        }
        if (decision.action === "highlight") {
          await overlay.scrollIntoViewIfNeeded(el);
          overlay.highlight(id, { durationMs: 8000, locator });
          return { ok: true, message: "highlighted", elementFound: true };
        }
        const ok = await overlay.pointAt(id, { durationMs: 12000, locator });
        return { ok, message: ok ? "pointing" : "could not point", elementFound: ok };
      }

      case "scroll_to": {
        const r = getEl();
        if ("error" in r) return r.error;
        r.el.scrollIntoView({ block: "center", behavior });
        await sleep(reduced ? 50 : 400);
        overlay.highlight(decision.elementId!, { durationMs: 4000 });
        return { ok: true, message: "scrolled to element", elementFound: true };
      }

      case "scroll": {
        const amount = decision.amount ?? 600;
        const delta = decision.direction === "up" ? -amount : amount;
        if (decision.x != null && decision.y != null) {
          // Wheel over an exact spot: scrolls that inner pane, or zooms that map/graph.
          const point = { x: decision.x, y: decision.y };
          const real = decision.trusted === true && (await sendReal([{ kind: "wheel", ...point, deltaY: delta }]));
          const moved = real || syntheticWheel(point, delta);
          await sleep(reduced ? 50 : 350);
          // A map or graph zooms on the wheel event itself and has nothing to scroll: only real input reaches it.
          return { ok: moved, message: moved ? `wheeled ${decision.direction} over ${describeElement(elementAtPoint(point))}${inputNote(real, true)}` : `nothing there scrolls${inputNote(false, false)}`, changed: moved };
        }
        const target = findScrollableRoot();
        const before = target ? target.scrollTop : window.scrollY;
        if (target && target !== document.scrollingElement && target !== document.documentElement) target.scrollBy({ top: delta, behavior });
        else window.scrollBy({ top: delta, behavior });
        await sleep(reduced ? 50 : 450);
        const after = target ? target.scrollTop : window.scrollY;
        const moved = Math.abs(after - before) > 2;
        return { ok: moved, message: moved ? `scrolled ${decision.direction}` : `already at the ${decision.direction === "up" ? "top" : "bottom"}`, changed: moved };
      }

      case "focus": {
        const r = getEl();
        if ("error" in r) return r.error;
        await overlay.scrollIntoViewIfNeeded(r.el);
        (r.el as HTMLElement).focus?.();
        overlay.highlight(decision.elementId!, { durationMs: 3000, kind: "acting" });
        return { ok: document.activeElement === r.el, message: "focused", elementFound: true };
      }

      case "click":
      case "double_click":
      case "right_click":
      case "hover": {
        // A plain click on a listed element keeps the DOM path below: it needs no debugger session.
        if (decision.action === "click" && decision.elementId != null) return clickElement();
        const t = await resolvePoint(decision.elementId, decision.x, decision.y);
        if ("error" in t) return t.error;
        const { point, el } = t;
        const hover = decision.action === "hover";
        if (!hover && el && ((el as HTMLButtonElement).disabled || el.closest('[aria-disabled="true"]'))) return { ok: false, message: "That control is disabled right now.", elementFound: true };
        markPoint(point);
        await sleep(reduced ? 30 : 200);
        const urlBefore = location.href;
        if (!hover) await deps.beforeMaybeNavigate?.();
        const op: InputOp = hover ? { kind: "move", ...point } : { kind: "click", ...point, button: decision.action === "right_click" ? "right" : "left", count: decision.action === "double_click" ? 2 : 1 };
        let real = decision.trusted === true && (await sendReal([op]));
        if (!real && el) {
          if (hover) syntheticHover(el, point);
          else if (decision.action === "right_click") syntheticContextMenu(el, point);
          else {
            dispatchClickSequence(el, point);
            if (decision.action === "double_click") {
              dispatchClickSequence(el, point);
              syntheticDoubleClick(el, point);
            }
          }
        }
        let change = await deps.waitForChange(hover ? 700 : 1400);
        // CSS :hover never reacts to events, and hovering twice is harmless, so a hover that
        // nothing answered gets the real mouse without being asked. Clicks never do: a second
        // click on something that did react would undo it.
        if (hover && !real && !change.changed && (real = await sendReal([op]))) change = await deps.waitForChange(700);
        const urlChanged = change.urlChanged || location.href !== urlBefore;
        const verb = { click: "clicked", double_click: "double-clicked", right_click: "right-clicked", hover: "hovering over" }[decision.action];
        const outcome = urlChanged ? "page navigated" : change.changed ? "page updated" : "no visible change";
        return { ok: true, message: `${verb} ${describeElement(el)} at (${Math.round(point.x)}, ${Math.round(point.y)}); ${outcome}${inputNote(real, change.changed || urlChanged)}`, changed: change.changed || urlChanged, urlChanged, elementFound: true };
      }

      case "drag": {
        const from = await resolvePoint(decision.elementId, decision.x, decision.y);
        if ("error" in from) return from.error;
        const toEl = decision.toElementId != null ? registry.get(decision.toElementId) : null;
        if (decision.toElementId != null && !toEl) return { ok: false, message: "The place to drop it isn't on the page anymore—let me look again.", elementFound: false };
        const to = toEl ? center(toEl) : { x: decision.toX!, y: decision.toY! };
        if (to.x < 0 || to.y < 0 || to.x > window.innerWidth || to.y > window.innerHeight) return { ok: false, message: "Both ends of a drag have to be on screen at once; scroll so they are.", elementFound: true };
        markPoint(from.point, 2200);
        markPoint(to, 2200);
        await sleep(reduced ? 30 : 200);
        const real = decision.trusted === true && (await sendReal([{ kind: "drag", ...from.point, toX: to.x, toY: to.y }]));
        if (!real) syntheticDrag(from.point, to);
        const change = await deps.waitForChange(1200);
        return { ok: true, message: `dragged ${describeElement(from.el)} to (${Math.round(to.x)}, ${Math.round(to.y)}); ${change.changed ? "page updated" : "no visible change"}${inputNote(real, change.changed)}`, changed: change.changed, elementFound: true };
      }

      case "press_key": {
        const chord = parseKeyChord(decision.text!)!;
        if (decision.elementId != null) {
          const r = getEl();
          if ("error" in r) return r.error;
          (r.el as HTMLElement).focus?.();
        }
        if (chord.key === "Enter") await deps.beforeMaybeNavigate?.();
        noteOwnKey();
        const real = decision.trusted === true && (await sendReal([{ kind: "key", chord }]));
        if (!real) syntheticKey(deepActiveElement() ?? document.body, chord);
        const { changed, urlChanged } = await deps.waitForChange(chord.key === "Enter" ? 2500 : 800);
        return { ok: true, message: `pressed ${decision.text}; ${urlChanged ? "page navigated" : changed ? "page updated" : "no visible change"}${inputNote(real, changed || urlChanged)}`, changed, urlChanged, elementFound: true };
      }

      case "type": {
        if (decision.elementId == null) {
          // Typing at the focus: canvas tools, spreadsheet cells and editors the element list can't name.
          const active = deepActiveElement();
          if (!active) return { ok: false, message: "Nothing is focused to type into. Click the spot first.", elementFound: false };
          if (isSensitiveField(active)) return { ok: false, message: "That field is private (password/payment/code)—please type it yourself.", elementFound: true };
          const real = decision.trusted === true && (await sendReal([{ kind: "text", text: decision.text ?? "" }]));
          if (!real) {
            // Page events can only fill a real text field; a canvas tool or custom editor takes keystrokes, which only real input delivers.
            if (!isEditable(active)) return { ok: false, message: `The focused ${describeElement(active)} isn't a text field, so page events can't type into it${inputNote(false, false)}`, elementFound: true };
            typeInto(active, decision.text ?? "", { clear: false });
          }
          await deps.waitForChange(300);
          return { ok: true, message: `typed into the focused ${describeElement(active)}${inputNote(real, true)}`, changed: true, elementFound: true };
        }
        const r = getEl();
        if ("error" in r) return r.error;
        const el = r.el;
        if (isSensitiveField(el)) return { ok: false, message: "That field is private (password/payment/code)—please type it yourself.", elementFound: true };
        if (!isEditable(el)) return { ok: false, message: "That isn't a place I can type.", elementFound: true };
        await overlay.scrollIntoViewIfNeeded(el);
        overlay.highlight(decision.elementId!, { durationMs: 2500, kind: "acting" });
        const value = typeInto(el, decision.text ?? "", { clear: true });
        await deps.waitForChange(300);
        const ok = normalizeText(value) === normalizeText(decision.text ?? "") || value.includes(decision.text ?? "");
        return { ok, message: ok ? "typed" : `typed, but the field now reads "${value.slice(0, 40)}"`, valueAfter: value.slice(0, 80), changed: true, elementFound: true };
      }

      case "clear": {
        const r = getEl();
        if ("error" in r) return r.error;
        if (isSensitiveField(r.el)) return { ok: false, message: "That field is private—please handle it yourself.", elementFound: true };
        if (!isEditable(r.el)) return { ok: false, message: "That isn't an editable field.", elementFound: true };
        clearElement(r.el);
        return { ok: true, message: "cleared", changed: true, elementFound: true };
      }

      case "select": {
        const r = getEl();
        if ("error" in r) return r.error;
        const el = r.el;
        const wanted = normalizeText(decision.value ?? "");
        if (el.tagName === "SELECT") {
          const sel = el as HTMLSelectElement;
          const idx = [...sel.options].findIndex((o) => normalizeText(o.text) === wanted || normalizeText(o.value) === wanted);
          const fuzzy = idx >= 0 ? idx : [...sel.options].findIndex((o) => normalizeText(o.text).includes(wanted));
          if (fuzzy < 0) return { ok: false, message: `No option called "${decision.value}"`, elementFound: true };
          overlay.highlight(decision.elementId!, { durationMs: 2500, kind: "acting" });
          sel.selectedIndex = fuzzy;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, message: `selected ${sel.options[fuzzy].text}`, changed: true, elementFound: true };
        }
        // Custom combobox/listbox: open it, then click the matching option.
        await overlay.scrollIntoViewIfNeeded(el);
        dispatchClickSequence(el);
        await deps.waitForChange(500);
        const page = deps.rescan();
        const option = page.elements.find((e) => (e.role === "option" || e.role === "menuitem" || e.role === "radio") && (normalizeText(e.name) === wanted || normalizeText(e.name).includes(wanted)));
        const optEl = option ? registry.get(option.id) : null;
        if (!optEl) return { ok: false, message: `I opened it but couldn't find "${decision.value}"`, elementFound: true };
        overlay.highlight(option!.id, { durationMs: 2000, kind: "acting" });
        dispatchClickSequence(optEl);
        await deps.waitForChange(400);
        return { ok: true, message: `selected ${option!.name}`, changed: true, elementFound: true };
      }

      case "navigate": {
        await deps.beforeMaybeNavigate?.();
        await deps.navigate(decision.url!);
        return { ok: true, message: "navigating", urlChanged: true, changed: true };
      }

      case "open_tab": {
        // The current page stays put; the new tab gets its own content script and session.
        await deps.openTab(decision.url!);
        return { ok: true, message: "opened in a new tab" };
      }

      case "show_plan": {
        return deps.showPlan() ? { ok: true, message: "plan map is showing" } : { ok: false, message: "We don't have a plan yet. Tell me something you want to learn about and I'll map it out.", elementFound: true };
      }

      case "sketch": {
        if (decision.value === "erase") {
          const r = deps.eraseSketch(decision.text!);
          if (!r) return { ok: false, message: "there is no drawing on screen to erase" };
          if (!r.erased) return { ok: false, message: "none of those numbers are on the drawing; see DRAWING ON SCREEN" };
          return { ok: true, message: r.left ? `erased ${r.erased} part${r.erased > 1 ? "s" : ""}; ${r.left} left on screen` : "drawing erased" };
        }
        deps.sketch(decision.text!, { add: decision.value === "add", elementId: decision.elementId, quote: decision.quote });
        return { ok: true, message: decision.value === "add" ? "added to the drawing" : "drawn on screen" };
      }

      case "switch_tab": {
        await deps.switchTab(decision.tabId!);
        return { ok: true, message: "switched to that tab" };
      }

      case "press_enter": {
        const r = getEl();
        if ("error" in r) return r.error;
        const el = r.el as HTMLElement;
        el.focus?.();
        await deps.beforeMaybeNavigate?.();
        const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true } as KeyboardEventInit;
        const proceed = el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        // Sites that only listen for form submission need the real thing when keydown wasn't handled.
        const form = (el as HTMLInputElement).form;
        if (proceed && form) form.requestSubmit ? form.requestSubmit() : form.submit();
        const { changed, urlChanged } = await deps.waitForChange(2500);
        return { ok: true, message: changed || urlChanged ? "pressed Enter" : "pressed Enter, but nothing seemed to happen", changed, urlChanged, elementFound: true };
      }

      case "go_back": {
        await deps.beforeMaybeNavigate?.();
        await deps.goBack();
        return { ok: true, message: "going back", urlChanged: true, changed: true };
      }

      default:
        return { ok: false, message: `unsupported action ${(decision as AgentDecision).action}` };
    }
  } catch (e) {
    logger.error("action failed", { action: decision.action, error: String(e) });
    return { ok: false, message: `That didn't work: ${e instanceof Error ? e.message : String(e)}` };
  }
}
