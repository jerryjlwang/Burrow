import type { PageElement, PageSummary, Rect } from "@shared/types";
import { ElementRegistry } from "./registry";

export const HOST_ID = "pip-companion-host";

export interface ExtractOptions {
  registry: ElementRegistry;
  /** Skip layout-based visibility checks (used in jsdom tests where there is no layout). */
  skipLayout?: boolean;
  maxElements?: number;
  maxTextChars?: number;
  viewport?: { width: number; height: number };
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "IFRAME", "OBJECT", "CANVAS", "VIDEO", "AUDIO", "MAP", "SOURCE", "TRACK"]);
const TEXT_INPUT_TYPES = new Set(["text", "email", "search", "url", "tel", "number", "password", "date", "datetime-local", "month", "week", "time", ""]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "slider", "spinbutton", "treeitem",
]);
const SENSITIVE_RE = /pass(word|code|phrase)?|card ?(number|no)|cc-|cvv|cvc|ssn|social security|one[- ]?time|otp|verification code|auth(entication)? code|security code|secret|\bpin\b|routing|account number|iban/i;
const ERROR_TEXT_RE = /\b(incorrect|not quite|try again|wrong|invalid|is required|required field|error|must be|doesn.?t match|does not match|failed|unable to|not allowed|denied|too short|too long|please enter|please select|oops)\b/i;
const SUCCESS_TEXT_RE = /\b(correct!|correct\b|well done|nice work|you got it|great job|success|submitted|saved|complete[d]?|that.s right|nailed it)\b|✓|✔/i;
const QUESTION_RE = /\?\s*$|\b(question|solve|problem|compute|calculate|evaluate|simplify|find (the|x)|what is)\b/i;

function collapse(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function intersectsViewport(r: Rect, vw: number, vh: number, margin = 0): boolean {
  return r.x + r.width > -margin && r.y + r.height > -margin && r.x < vw + margin && r.y < vh + margin;
}

function isVisibleStyle(style: CSSStyleDeclaration): boolean {
  if (style.display === "none") return false;
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (style.opacity !== "" && Number(style.opacity) === 0) return false;
  return true;
}

export function implicitRole(el: Element): string | null {
  const tag = el.tagName;
  if (tag === "A") return (el as HTMLAnchorElement).hasAttribute("href") ? "link" : null;
  if (tag === "BUTTON") return "button";
  if (tag === "SUMMARY") return "button";
  if (tag === "SELECT") return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "OPTION") return "option";
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).getAttribute("type") ?? "").toLowerCase();
    if (BUTTON_INPUT_TYPES.has(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "search") return "searchbox";
    if (type === "number") return "spinbutton";
    if (type === "hidden") return null;
    if (type === "file" || type === "color") return "button";
    if (TEXT_INPUT_TYPES.has(type)) return "textbox";
    return "textbox";
  }
  if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "heading";
  if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return "textbox";
  return null;
}

export function roleOf(el: Element): string | null {
  const explicit = collapse(el.getAttribute("role")).split(" ")[0];
  if (explicit) {
    if (explicit === "presentation" || explicit === "none") return null;
    return explicit;
  }
  return implicitRole(el);
}

function textOfNode(el: Element, max = 120): string {
  const t = collapse((el as HTMLElement).innerText ?? el.textContent);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function labelText(el: Element): string {
  const id = el.getAttribute("id");
  const doc = el.ownerDocument;
  if (id) {
    const safe = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
    const lab = doc.querySelector(`label[for="${safe}"]`);
    if (lab) return textOfNode(lab, 80);
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
    return collapse(clone.textContent).slice(0, 80);
  }
  return "";
}

export function accessibleName(el: Element, role: string | null): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => textOfNode(n, 80));
    const joined = collapse(parts.join(" "));
    if (joined) return joined;
  }
  const ariaLabel = collapse(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  const tag = el.tagName;
  const isField = ["textbox", "searchbox", "spinbutton", "combobox", "listbox", "checkbox", "radio", "slider", "switch"].includes(role ?? "");
  if (isField || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const lab = labelText(el);
    if (lab) return lab;
    const ph = collapse(el.getAttribute("placeholder") ?? el.getAttribute("aria-placeholder"));
    if (ph) return ph;
    const title = collapse(el.getAttribute("title"));
    if (title) return title;
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      if (BUTTON_INPUT_TYPES.has((input.getAttribute("type") ?? "").toLowerCase())) {
        const v = collapse(input.value || input.getAttribute("alt"));
        if (v) return v;
      }
      if (input.type === "checkbox" || input.type === "radio") {
        const v = collapse(input.value);
        const name = collapse(input.getAttribute("name"));
        if (v && v !== "on") return v;
        if (name) return humanize(name);
      }
    }
    const nameAttr = collapse(el.getAttribute("name"));
    if (nameAttr) return humanize(nameAttr);
  }
  const text = textOfNode(el, 80);
  if (text) return text;
  const img = el.querySelector("img[alt], svg title, [aria-label]");
  if (img) {
    const alt = collapse(img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? img.textContent);
    if (alt) return alt;
  }
  const title = collapse(el.getAttribute("title"));
  if (title) return title;
  const value = collapse((el as HTMLInputElement).value);
  if (value && tag === "INPUT") return value;
  return "";
}

export function humanize(s: string): string {
  return s
    .replace(/[_\-\[\]]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isSensitiveField(el: Element): boolean {
  if (el.tagName === "INPUT") {
    const type = ((el as HTMLInputElement).getAttribute("type") ?? "").toLowerCase();
    if (type === "password") return true;
    const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (/cc-|one-time-code|password/.test(ac)) return true;
  }
  const probe = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("autocomplete"), labelText(el)]
    .filter(Boolean)
    .join(" ");
  return SENSITIVE_RE.test(probe);
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled === true) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  const fieldset = el.closest("fieldset[disabled]");
  if (fieldset && !el.closest("legend")) return true;
  return false;
}

function isInteractiveCandidate(el: Element, role: string | null, style: CSSStyleDeclaration | null): boolean {
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.tagName === "DETAILS" || el.tagName === "LABEL") return false;
  const tabindex = el.getAttribute("tabindex");
  if (el.hasAttribute("onclick")) return true;
  if (tabindex !== null && Number(tabindex) >= 0 && !["DIV", "SPAN", "SECTION", "MAIN", "ARTICLE", "UL", "LI", "BODY"].includes(el.tagName)) return true;
  if (tabindex !== null && Number(tabindex) >= 0 && style?.cursor === "pointer") return true;
  return false;
}

interface Candidate {
  el: Element;
  role: string;
  rect: Rect;
  inViewport: boolean;
  order: number;
}

/** Produces the compact semantic page model plus fills the registry with the elements it lists. */
export function extractPage(doc: Document, opts: ExtractOptions): PageSummary {
  const { registry } = opts;
  const win = doc.defaultView ?? window;
  const vw = opts.viewport?.width ?? win.innerWidth;
  const vh = opts.viewport?.height ?? win.innerHeight;
  const maxElements = opts.maxElements ?? 400;
  // Not a budget: the model gets the whole page. This only keeps a pathological page (a
  // megabyte of log output) inside the model's context window instead of failing the request.
  const maxTextChars = opts.maxTextChars ?? 120_000;
  const skipLayout = !!opts.skipLayout;
  const host = doc.getElementById(HOST_ID);

  const headings: { text: string; el: Element; y: number }[] = [];
  const candidates: Candidate[] = [];
  const textBlocks: { text: string; inViewport: boolean; y: number }[] = [];
  const errors = new Set<string>();
  const successes = new Set<string>();
  const dialogs: string[] = [];
  const landmarks: string[] = [];
  let forms = 0;
  let order = 0;

  const root = doc.body ?? doc.documentElement;
  if (!root) {
    return emptySummary(doc, vw, vh);
  }

  // Depth-first walk that can skip hidden subtrees cheaply.
  const walk = (el: Element, inheritedHidden: boolean): void => {
    if (el === host) return;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    if ((el as HTMLElement).hidden) return;
    if (tag === "INPUT" && (el as HTMLInputElement).type === "hidden") return;

    let style: CSSStyleDeclaration | null = null;
    if (!skipLayout || (el as HTMLElement).style?.length || el.hasAttribute("style")) {
      try {
        style = win.getComputedStyle(el);
      } catch {
        style = null;
      }
    }
    if (style && !isVisibleStyle(style)) {
      if (style.display === "none" || style.visibility === "collapse" || Number(style.opacity) === 0) return;
      // visibility:hidden can be overridden by children: keep walking but don't record this node.
      for (const child of el.children) walk(child, true);
      return;
    }
    const hidden = inheritedHidden && !(style && style.visibility === "visible");

    let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
    let rendered = true;
    if (!skipLayout) {
      rect = rectOf(el);
      rendered = rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0;
      if (!rendered && tag !== "SVG" && el.children.length === 0 && !el.textContent?.trim()) return;
      if (rect.x + rect.width < -50 && rect.width < 5) return; // clipped off-screen junk
    }
    const inViewport = skipLayout ? true : intersectsViewport(rect, vw, vh);

    const role = roleOf(el);
    const isDialog = tag === "DIALOG" ? (el as HTMLDialogElement).open : role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true";
    if (isDialog && !hidden && (skipLayout || rendered)) {
      const name = accessibleName(el, "dialog") || textOfNode(el.querySelector("h1,h2,h3,[role=heading]") ?? el, 80);
      dialogs.push(name || "dialog");
    }
    if (tag === "FORM" && (skipLayout || rendered)) forms++;
    if (["MAIN", "NAV", "HEADER", "FOOTER", "ASIDE"].includes(tag) || ["main", "navigation", "banner", "contentinfo", "complementary", "search"].includes(role ?? "")) {
      const lm = role ?? tag.toLowerCase();
      const name = collapse(el.getAttribute("aria-label"));
      landmarks.push(name ? `${lm}: ${name}` : lm);
    }

    if (!hidden && (skipLayout || rendered)) {
      if (role === "heading") {
        const t = textOfNode(el, 100);
        if (t) headings.push({ text: t, el, y: rect.y });
      }
      if (role && role !== "heading" && isInteractiveCandidate(el, role, style)) {
        if (!(role === "option" && el.closest("select"))) {
          candidates.push({ el, role, rect, inViewport, order: order++ });
        }
      } else if (!role && isInteractiveCandidate(el, null, style)) {
        const t = textOfNode(el, 60);
        if (t && t.length <= 60 && (skipLayout || rect.width < 500)) candidates.push({ el, role: "button", rect, inViewport, order: order++ });
      }

      // Error / success / alert detection on small text-bearing elements.
      if (el.childElementCount <= 4) {
        const t = textOfNode(el, 200);
        if (t && t.length <= 200) {
          const cls = `${el.className && typeof el.className === "string" ? el.className : ""} ${el.id ?? ""}`;
          const roleAlert = role === "alert" || role === "status" || el.getAttribute("aria-live") === "assertive" || el.getAttribute("aria-invalid") === "true";
          const errorish = roleAlert || /error|invalid|danger|incorrect|warning|alert|feedback|fail/i.test(cls);
          if ((errorish && ERROR_TEXT_RE.test(t)) || (roleAlert && t.length < 120 && !SUCCESS_TEXT_RE.test(t))) errors.add(t);
          else if ((errorish || roleAlert || /success|correct|complete/i.test(cls)) && SUCCESS_TEXT_RE.test(t)) successes.add(t);
        }
      }
    }

    // Visible text blocks: leaf-ish elements with direct text.
    if (!hidden && (skipLayout || rendered)) {
      let direct = "";
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) direct += node.textContent ?? "";
      }
      direct = collapse(direct);
      if (direct.length > 1 && !["OPTION", "BUTTON", "A", "LABEL", "TEXTAREA"].includes(tag)) {
        textBlocks.push({ text: direct, inViewport, y: rect.y });
      }
    }

    for (const child of el.children) walk(child, hidden);
  };
  walk(root, false);

  // Rank + cap interactive elements: viewport first, then document order.
  candidates.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.order - b.order);
  const seenNames = new Map<Element, string>();
  const elements: PageElement[] = [];
  let truncated = 0;
  for (const c of candidates) {
    if (elements.length >= maxElements) {
      truncated++;
      continue;
    }
    const name = accessibleName(c.el, c.role);
    // Skip nested duplicates (e.g. <a><button>Same</button></a>).
    const parentInteractive = c.el.parentElement?.closest("a[href],button,[role=button],[role=link]");
    if (parentInteractive && seenNames.get(parentInteractive) === name) continue;
    seenNames.set(c.el, name);
    if (!name && c.role !== "textbox" && c.role !== "searchbox" && c.role !== "combobox") continue;

    const id = registry.idFor(c.el);
    const item: PageElement = { id, role: c.role, name: name.slice(0, 80) || `${c.role}`, tag: c.el.tagName.toLowerCase(), inViewport: c.inViewport, rect: c.rect };
    if (isDisabled(c.el)) item.disabled = true;
    const ariaChecked = c.el.getAttribute("aria-checked");
    if (c.role === "checkbox" || c.role === "radio" || c.role === "switch" || c.role === "menuitemcheckbox" || c.role === "menuitemradio") {
      item.checked = ariaChecked ? ariaChecked === "true" : (c.el as HTMLInputElement).checked === true;
    }
    const ariaSelected = c.el.getAttribute("aria-selected");
    if (ariaSelected !== null) item.selected = ariaSelected === "true";
    if (c.role === "option" && (c.el as HTMLOptionElement).selected) item.selected = true;
    const current = c.el.getAttribute("aria-current");
    if (current && current !== "false") item.current = true;
    const expanded = c.el.getAttribute("aria-expanded");
    if (expanded !== null) item.expanded = expanded === "true";
    if ((c.el as HTMLInputElement).required || c.el.getAttribute("aria-required") === "true") item.required = true;
    if (c.el.getAttribute("aria-invalid") === "true") item.invalid = true;
    if (c.role === "link") {
      const href = (c.el as HTMLAnchorElement).href;
      if (href && !href.startsWith("javascript:")) item.href = href.slice(0, 200);
    }
    if (["textbox", "searchbox", "spinbutton", "combobox"].includes(c.role)) {
      const sensitive = isSensitiveField(c.el);
      if (sensitive) item.sensitive = true;
      const placeholder = collapse(c.el.getAttribute("placeholder"));
      if (placeholder) item.placeholder = placeholder.slice(0, 60);
      const type = c.el.tagName === "INPUT" ? (c.el as HTMLInputElement).type : c.el.tagName === "TEXTAREA" ? "textarea" : undefined;
      if (type) item.inputType = type;
      if (!sensitive) {
        let value = "";
        if (c.el.tagName === "SELECT") {
          const sel = c.el as HTMLSelectElement;
          value = collapse(sel.options[sel.selectedIndex]?.text ?? "");
        } else if (c.el.tagName === "TEXTAREA") {
          // Written working is line-structured: keep newlines so step-judging and line anchors
          // (1-based lines) survive into the page model the agent reasons over.
          value = (c.el as HTMLTextAreaElement).value.split("\n").map((l) => collapse(l)).join("\n").replace(/\n+$/, "");
        } else if (c.el.tagName === "INPUT") {
          value = collapse((c.el as HTMLInputElement).value);
        } else if ((c.el as HTMLElement).isContentEditable) {
          value = textOfNode(c.el, 80);
        }
        if (value) item.value = value.slice(0, 200);
      }
    }
    const ctx = nearbyContext(c.el, headings, name);
    if (ctx) item.context = ctx;
    elements.push(item);
  }
  registry.prune();

  // Text summary: viewport text first, then the rest, capped.
  textBlocks.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.y - b.y);
  let textSummary = "";
  const seenText = new Set<string>();
  for (const b of textBlocks) {
    if (seenText.has(b.text)) continue;
    seenText.add(b.text);
    if (textSummary.length + b.text.length + 1 > maxTextChars) {
      if (textSummary.length < maxTextChars - 40) textSummary += " " + b.text.slice(0, maxTextChars - textSummary.length - 2) + "…";
      break;
    }
    textSummary += (textSummary ? "\n" : "") + b.text;
  }

  let selection = "";
  try {
    selection = collapse(win.getSelection()?.toString()).slice(0, 1500);
  } catch {
    selection = "";
  }

  const isPdf = doc.contentType === "application/pdf" || !!doc.querySelector('embed[type="application/pdf"]');
  const bodyText = `${headings.map((h) => h.text).join(" ")} ${textSummary}`;
  const hasAnswerControls = elements.some((e) => ["radio", "checkbox", "textbox", "spinbutton", "textarea"].includes(e.role));
  const hasSubmitLike = elements.some((e) => e.role === "button" && /submit|check|answer|next|done|finish|turn in/i.test(e.name));
  const hasQuizUi = QUESTION_RE.test(bodyText) && hasAnswerControls && hasSubmitLike;

  const scrollEl = doc.scrollingElement ?? doc.documentElement;
  return {
    url: doc.location?.href ?? "",
    title: collapse(doc.title).slice(0, 120),
    headings: headings.slice(0, 30).map((h) => h.text),
    textSummary,
    elements,
    errors: [...errors].slice(0, 6),
    successes: [...successes].slice(0, 4),
    dialogs: dialogs.slice(0, 3),
    forms,
    landmarks: [...new Set(landmarks)].slice(0, 8),
    selection: selection || undefined,
    isPdf,
    hasQuizUi,
    scroll: { x: Math.round(win.scrollX ?? 0), y: Math.round(win.scrollY ?? 0), maxY: Math.max(0, (scrollEl?.scrollHeight ?? 0) - vh) },
    viewport: { width: vw, height: vh },
    capturedAt: Date.now(),
    truncatedElements: truncated,
  };
}

function emptySummary(doc: Document, vw: number, vh: number): PageSummary {
  return {
    url: doc.location?.href ?? "",
    title: collapse(doc.title),
    headings: [],
    textSummary: "",
    elements: [],
    errors: [],
    successes: [],
    dialogs: [],
    forms: 0,
    landmarks: [],
    isPdf: doc.contentType === "application/pdf",
    hasQuizUi: false,
    scroll: { x: 0, y: 0, maxY: 0 },
    viewport: { width: vw, height: vh },
    capturedAt: Date.now(),
    truncatedElements: 0,
  };
}

/** Finds a short label that gives an element meaning: group legend, described-by text, or the nearest preceding heading. */
export function nearbyContext(el: Element, headings: { text: string; el: Element }[], ownName: string): string | undefined {
  const describedBy = el.getAttribute("aria-describedby");
  if (describedBy) {
    const t = describedBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => textOfNode(n, 80))
      .join(" ");
    if (t && t !== ownName) return collapse(t).slice(0, 100);
  }
  const fieldset = el.closest("fieldset");
  const legend = fieldset?.querySelector("legend");
  if (legend) {
    const t = textOfNode(legend, 80);
    if (t && t !== ownName) return t;
  }
  const group = el.closest("[role=group],[role=radiogroup]");
  if (group) {
    const t = collapse(group.getAttribute("aria-label")) || (group.getAttribute("aria-labelledby") ? textOfNode(el.ownerDocument.getElementById(group.getAttribute("aria-labelledby")!) ?? group, 80) : "");
    if (t && t !== ownName) return t;
  }
  // Nearest preceding heading in document order.
  let best: string | undefined;
  for (const h of headings) {
    const pos = h.el.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h.text;
    else break;
  }
  return best && best !== ownName ? best.slice(0, 100) : undefined;
}
