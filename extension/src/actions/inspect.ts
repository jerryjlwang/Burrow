import { isField, quoteSpan, textNodesUnder } from "./locate";

/**
 * The region inspector behind `observe` targeting: resolve an element id or a verbatim quote to
 * the region around it and return that region's FULL text. This is the general read primitive —
 * video descriptions, long paragraphs, comment threads, anything the page summary truncates —
 * instead of a bespoke verb per content type.
 */

export const MAX_REGION_CHARS = 3500;
/** A region worth reading has at least this much text; smaller matches climb to their container. */
const MIN_REGION_CHARS = 160;
/** Stop climbing before page-scale containers: a readout is a region, not the whole document. */
const MAX_REGION_CLIMB_CHARS = 8000;

/** Full readable text of one element: a field's value, or rendered text with line structure kept. */
export function regionText(el: Element): string {
  if (isField(el)) return el.value;
  const rendered = (el as HTMLElement).innerText;
  // innerText skips hidden content; fall back to textContent when the region renders as (nearly)
  // nothing — a collapsed description still has its text in the DOM.
  const text = rendered && rendered.trim().length >= 40 ? rendered : (el.textContent ?? rendered ?? "");
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The element whose text contains the quote. For reading (the default) it grows to a container
 * with enough context to be worth reading; `grow: false` returns the tightest containing element,
 * which is what wrapping a drawing onto the quote wants. Null when the quote is nowhere under
 * `root` — the caller reports that honestly.
 */
export function quoteRegion(root: Element, quote: string, skipId?: string, opts: { grow?: boolean } = {}): Element | null {
  const nodes = textNodesUnder(root, skipId);
  let joined = "";
  const starts: number[] = [];
  for (const n of nodes) {
    starts.push(joined.length);
    joined += n.data;
  }
  const span = quoteSpan(joined, quote);
  if (span) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (span.start >= starts[i]) return opts.grow === false ? nodes[i].parentElement : growRegion(nodes[i].parentElement, root);
    }
  }
  // The student's own working lives in field values, not text nodes.
  for (const el of root.querySelectorAll("textarea, input")) {
    if (isField(el) && el.value && quoteSpan(el.value, quote)) return el;
  }
  return null;
}

/** Climb from the matched element (often a heading or a single line) to its surrounding region. */
function growRegion(start: Element | null, root: Element): Element | null {
  let el = start;
  while (el && el !== root && regionText(el).length < MIN_REGION_CHARS) {
    const parent = el.parentElement;
    if (!parent || parent === root || regionText(parent).length > MAX_REGION_CLIMB_CHARS) break;
    el = parent;
  }
  return el;
}
