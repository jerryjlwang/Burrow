import type { Rect } from "@shared/types";

/**
 * Sub-element target resolution: turn "line 2 of this textarea" or a verbatim quote into live
 * viewport rects. Locators are re-invoked every overlay frame so scrolling and layout shifts
 * stay accurate; the expensive parts (mirror layout, quote search) are cached and only the
 * element rect + scroll offsets are re-read per frame.
 */
export type RectLocator = () => Rect | null;

export type FieldEl = HTMLTextAreaElement | HTMLInputElement;

export const isField = (el: Element): el is FieldEl => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;

// ---------- pure text mapping (unit-tested) ----------

/** Character range [start, end) of a 1-based line within a multi-line value; null when out of range. */
export function lineSpan(value: string, line: number): { start: number; end: number } | null {
  if (line < 1) return null;
  const lines = value.split("\n");
  // Blank lines can't be measured or pointed at; refuse rather than highlight nothing.
  if (line > lines.length || !lines[line - 1].trim()) return null;
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += lines[i].length + 1;
  return { start, end: start + lines[line - 1].length };
}

const collapse = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Find a quote in a raw text, whitespace-insensitively, and map it back to raw offsets.
 * Returns null when the quote does not occur — the caller must then refuse to point.
 */
export function quoteSpan(raw: string, quote: string): { start: number; end: number } | null {
  const needle = collapse(quote);
  if (!needle) return null;
  // Build the collapsed haystack together with a map from collapsed index → raw index.
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0;
      continue;
    }
    if (pendingSpace) {
      norm += " ";
      map.push(i - 1);
      pendingSpace = false;
    }
    norm += ch.toLowerCase();
    map.push(i);
  }
  const at = norm.indexOf(needle);
  if (at === -1) return null;
  const start = map[at];
  const endNorm = at + needle.length - 1;
  return { start, end: map[endNorm] + 1 };
}

// ---------- field (textarea/input) measurement ----------

const MIRROR_PROPS = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing", "textTransform",
  "textIndent", "lineHeight", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "wordBreak", "overflowWrap",
] as const;

interface CachedSpanRect {
  key: string;
  rel: Rect;
}

const fieldCache = new WeakMap<FieldEl, CachedSpanRect>();

/** Measure where value[start..end) renders inside a field, relative to its padding box. */
function measureFieldSpan(el: FieldEl, start: number, end: number): Rect | null {
  const key = `${start}:${end}:${el.value}:${el.clientWidth}`;
  const cached = fieldCache.get(el);
  if (cached?.key === key) return cached.rel;
  const cs = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
  mirror.style.whiteSpace = el instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${el.clientWidth}px`;
  mirror.style.position = "fixed";
  mirror.style.top = "0";
  mirror.style.left = "-99999px";
  mirror.style.visibility = "hidden";
  const span = document.createElement("span");
  span.textContent = el.value.slice(start, end) || "​";
  mirror.append(document.createTextNode(el.value.slice(0, start)), span, document.createTextNode(el.value.slice(end)));
  document.body.appendChild(mirror);
  const mr = mirror.getBoundingClientRect();
  const sr = span.getBoundingClientRect();
  mirror.remove();
  if (sr.width === 0 && sr.height === 0) return null;
  const rel: Rect = { x: sr.left - mr.left, y: sr.top - mr.top, width: sr.width, height: sr.height };
  fieldCache.set(el, { key, rel });
  return rel;
}

function fieldSpanLocator(el: FieldEl, span: () => { start: number; end: number } | null): RectLocator {
  return () => {
    const s = span();
    if (!s) return null;
    const rel = measureFieldSpan(el, s.start, s.end);
    if (!rel) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x + el.clientLeft + rel.x - el.scrollLeft,
      y: r.y + el.clientTop + rel.y - el.scrollTop,
      width: rel.width,
      height: rel.height,
    };
  };
}

/** Locator for a 1-based line of a field's value. Tracks edits: the span is recomputed per frame. */
export function lineLocator(el: Element, line: number): RectLocator | null {
  if (!isField(el)) return null;
  if (!lineSpan(el.value, line)) return null;
  return fieldSpanLocator(el, () => lineSpan(el.value, line));
}

// ---------- quote resolution (DOM text or field values) ----------

export function textNodesUnder(root: Node, skipId?: string): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (skipId && parent.closest(`#${skipId}`)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/**
 * Resolve a verbatim quote to a live rect: first in the DOM text under `root`, then in visible
 * field values. Returns null when the quote is nowhere on the page — the executor treats that as
 * a failed action rather than pointing at nothing.
 */
export function quoteLocator(root: Element, quote: string, skipId?: string): RectLocator | null {
  // DOM text: concatenate node texts and map the collapsed match back onto a Range.
  const nodes = textNodesUnder(root, skipId);
  let joined = "";
  const nodeStarts: number[] = [];
  for (const n of nodes) {
    nodeStarts.push(joined.length);
    joined += n.data;
  }
  const span = quoteSpan(joined, quote);
  if (span) {
    const locate = (offset: number): { node: Text; offset: number } | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (offset >= nodeStarts[i]) return { node: nodes[i], offset: Math.min(offset - nodeStarts[i], nodes[i].data.length) };
      }
      return null;
    };
    const from = locate(span.start);
    const to = locate(span.end);
    if (from && to) {
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch {
        return null;
      }
      return () => {
        const r = range.getBoundingClientRect();
        return r.width === 0 && r.height === 0 ? null : { x: r.left, y: r.top, width: r.width, height: r.height };
      };
    }
  }
  // Field values (textarea/input): quotes of the student's own working live here, not in text nodes.
  for (const el of root.querySelectorAll<HTMLElement>("textarea, input")) {
    if (!isField(el) || !el.value) continue;
    if (quoteSpan(el.value, quote)) {
      const field = el;
      return fieldSpanLocator(field, () => quoteSpan(field.value, quote));
    }
  }
  return null;
}
