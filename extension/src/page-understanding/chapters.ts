import { parseChapters, type Chapter } from "@shared/chapters";
import { quoteLocator, type RectLocator } from "../actions/locate";
import { HOST_ID } from "./extract";

/** YouTube keeps the description in this element, collapsed to a couple of lines until "...more" is clicked. */
const YT_DESCRIPTION = "ytd-text-inline-expander";

const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;

/**
 * Where a page's chapter list lives and how to get at it. On YouTube that is the description,
 * which has to be opened first; anywhere else the chapters are read off the page as it stands.
 */
function descriptionRoot(): HTMLElement {
  return document.querySelector<HTMLElement>(YT_DESCRIPTION) ?? document.body;
}

/** Opens a collapsed description and waits for its full text. Resolves true when it had to open one. */
export async function openDescription(timeoutMs = 2500): Promise<boolean> {
  const root = document.querySelector<HTMLElement>(YT_DESCRIPTION);
  if (!root || root.hasAttribute("is-expanded")) return false;
  const expand = [...root.querySelectorAll<HTMLElement>("#expand")].find(visible);
  if (!expand) return false;
  expand.click();
  const started = Date.now();
  while (!root.hasAttribute("is-expanded") && Date.now() - started < timeoutMs) await new Promise((r) => setTimeout(r, 100));
  return true;
}

export function readChapters(): Chapter[] {
  return parseChapters(descriptionRoot().innerText);
}

/**
 * The chapter's own line on the page. `el` is what gets scrolled to — its timestamp link when
 * there is one, so the right entry is found even if the title's words appear elsewhere — and
 * `locator` rings the whole line, timestamp and title together.
 */
export function chapterTarget(chapter: Chapter): { el: HTMLElement; locator: RectLocator | undefined } {
  const root = descriptionRoot();
  const links = [...root.querySelectorAll<HTMLElement>("a")].filter(visible);
  const text = (a: HTMLElement) => a.textContent?.trim() ?? "";
  // YouTube links just the timestamp; other sites link the whole line.
  const link = links.find((a) => text(a) === chapter.stamp) ?? links.find((a) => text(a).startsWith(chapter.stamp) && text(a).includes(chapter.title.slice(0, 24)));
  return { el: link ?? holderOf(root, chapter.title) ?? root, locator: quoteLocator(root, chapter.line, HOST_ID) ?? undefined };
}

/** The element whose own text carries `needle`: where an unlinked chapter line lives. */
function holderOf(root: HTMLElement, needle: string): HTMLElement | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && !parent.closest(`#${HOST_ID}`) && node.textContent?.includes(needle) && visible(parent)) return parent;
  }
  return null;
}
