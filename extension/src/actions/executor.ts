import type { AgentDecision } from "@shared/actions";
import type { ActionResult, PageSummary } from "@shared/types";
import { normalizeText } from "@shared/text";
import { ElementRegistry } from "../page-understanding/registry";
import { isSensitiveField } from "../page-understanding/extract";
import { OverlayController } from "./overlay";
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
  goBack: () => Promise<void>;
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

export function dispatchClickSequence(el: Element): void {
  const { x, y } = center(el);
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
  if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
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

      case "highlight": {
        const r = getEl();
        if ("error" in r) return r.error;
        await overlay.scrollIntoViewIfNeeded(r.el);
        overlay.highlight(decision.elementId!, { durationMs: 8000 });
        return { ok: true, message: "highlighted", elementFound: true };
      }

      case "point_to": {
        const r = getEl();
        if ("error" in r) return r.error;
        const ok = await overlay.pointAt(decision.elementId!, { durationMs: 12000 });
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

      case "click": {
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
      }

      case "type": {
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
